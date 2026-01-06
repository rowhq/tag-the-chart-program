use crate::state::TradingAccount;
use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount};
use raydium_amm_v3::{
    cpi,
    program::AmmV3,
    states::{AmmConfig, PoolState},
};

declare_id!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

pub fn swap_to_prices<'info>(
    ctx: Context<'_, '_, '_, 'info, SwapCandle<'info>>,
    to_sqrt_prices: [u128; 3], // Target sqrt prices (X64 format) for each swap
    max_inputs: [u64; 3],      // Max input amounts (0 = no limit)
    min_outputs: [u64; 3],     // Min output amounts (0 = no limit)
) -> Result<()> {
    let user_key = ctx.accounts.user.key();
    let bump = ctx.accounts.trading_account.bump;

    let seeds = &[b"trading_account", user_key.as_ref(), &[bump]];
    let signer = &[&seeds[..]];

    for (i, to_sqrt_price) in to_sqrt_prices.iter().enumerate() {
        let from_sqrt_price = {
            let pool = ctx.accounts.pool_state.load()?;
            pool.sqrt_price_x64
        };

        let price_increasing = *to_sqrt_price > from_sqrt_price;
        let a_to_b = !price_increasing;

        swap_to_price(
            &ctx,
            signer,
            *to_sqrt_price,
            a_to_b,
            max_inputs[i],
            min_outputs[i],
        )?;

        verify_price_reached(&ctx, from_sqrt_price, *to_sqrt_price)?;
    }

    Ok(())
}

/// Verify that the swap reached the target price within tolerance and emit event
fn verify_price_reached<'info>(
    ctx: &Context<'_, '_, '_, 'info, SwapCandle<'info>>,
    from_sqrt_price: u128,
    to_sqrt_price: u128,
) -> Result<()> {
    let actual_sqrt_price = {
        let pool = ctx.accounts.pool_state.load()?;
        pool.sqrt_price_x64
    };

    let diff = if actual_sqrt_price > to_sqrt_price {
        actual_sqrt_price - to_sqrt_price
    } else {
        to_sqrt_price - actual_sqrt_price
    };

    let tolerance = to_sqrt_price / 1000;
    require!(diff <= tolerance, ErrorCode::PriceNotReached);

    emit!(SwapExecuted {
        from_sqrt_price,
        to_sqrt_price,
        actual_sqrt_price,
    });

    Ok(())
}

/// Executes a swap to a target price with optional input/output limits.
/// Uses sqrt_price_limit to stop at the exact target price.
fn swap_to_price<'info>(
    ctx: &Context<'_, '_, '_, 'info, SwapCandle<'info>>,
    signer_seeds: &[&[&[u8]]],
    to_sqrt_price: u128,
    a_to_b: bool,
    max_input: u64,
    min_output: u64,
) -> Result<()> {
    let amount_specified = if max_input == 0 { u64::MAX } else { max_input };
    let minimum_amount_out = min_output;

    let wsol_mint = pubkey!("So11111111111111111111111111111111111111112");
    let is_mint_a_wsol = ctx.accounts.token_mint_a.key() == wsol_mint;

    // Map trading account token accounts to A/B positions based on a_to_b direction
    let (input_token_account, output_token_account) = if a_to_b {
        // Swapping from A to B
        if is_mint_a_wsol {
            (
                ctx.accounts.trading_account_wsol.to_account_info(),
                ctx.accounts.trading_account_token.to_account_info(),
            )
        } else {
            (
                ctx.accounts.trading_account_token.to_account_info(),
                ctx.accounts.trading_account_wsol.to_account_info(),
            )
        }
    } else {
        // Swapping from B to A
        if is_mint_a_wsol {
            (
                ctx.accounts.trading_account_token.to_account_info(),
                ctx.accounts.trading_account_wsol.to_account_info(),
            )
        } else {
            (
                ctx.accounts.trading_account_wsol.to_account_info(),
                ctx.accounts.trading_account_token.to_account_info(),
            )
        }
    };

    let (input_vault, output_vault, input_vault_mint, output_vault_mint) = if a_to_b {
        (
            ctx.accounts.token_vault_a.to_account_info(),
            ctx.accounts.token_vault_b.to_account_info(),
            ctx.accounts.token_mint_a.to_account_info(),
            ctx.accounts.token_mint_b.to_account_info(),
        )
    } else {
        (
            ctx.accounts.token_vault_b.to_account_info(),
            ctx.accounts.token_vault_a.to_account_info(),
            ctx.accounts.token_mint_b.to_account_info(),
            ctx.accounts.token_mint_a.to_account_info(),
        )
    };

    // Build the CPI context for Raydium swap_v2 (supports Token2022)
    let cpi_accounts = cpi::accounts::SwapSingleV2 {
        payer: ctx.accounts.trading_account.to_account_info(),
        amm_config: ctx.accounts.amm_config.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        input_token_account,
        output_token_account,
        input_vault,
        output_vault,
        input_vault_mint,
        output_vault_mint,
        observation_state: ctx.accounts.observation_state.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
        memo_program: ctx.accounts.memo_program.to_account_info(),
    };

    let raydium = ctx.accounts.raydium_program.to_account_info();
    let cpi_ctx = CpiContext::new_with_signer(raydium, cpi_accounts, signer_seeds)
        .with_remaining_accounts(ctx.remaining_accounts.to_vec());

    // Execute swap_v2 with target sqrt price as limit
    cpi::swap_v2(
        cpi_ctx,
        amount_specified,
        minimum_amount_out,
        to_sqrt_price,
        true,
    )?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(target_sqrt_prices: [u128; 3], max_inputs: [u64; 3], min_outputs: [u64; 3])]
pub struct SwapCandle<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"trading_account", user.key().as_ref()],
        bump = trading_account.bump,
        constraint = trading_account.owner == user.key() @ ErrorCode::Unauthorized
    )]
    pub trading_account: Account<'info, TradingAccount>,

    pub raydium_program: Program<'info, AmmV3>,

    pub amm_config: Box<Account<'info, AmmConfig>>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// Token2022 account for the non-SOL token (owned by trading_account PDA)
    #[account(
        mut,
        constraint = trading_account_token.owner == trading_account.key()
    )]
    pub trading_account_token: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Wrapped SOL account (owned by trading_account PDA)
    #[account(
        mut,
        constraint = trading_account_wsol.owner == trading_account.key()
    )]
    pub trading_account_wsol: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub token_vault_a: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub token_vault_b: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = token_vault_a.mint)]
    pub token_mint_a: Box<InterfaceAccount<'info, Mint>>,

    #[account(address = token_vault_b.mint)]
    pub token_mint_b: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Observation state is validated by Raydium CLMM
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    pub token_program_2022: Program<'info, Token2022>,

    /// CHECK: SPL Memo program
    #[account(address = ID)]
    pub memo_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized: You don't own this trading account")]
    Unauthorized,
    #[msg("Price not reached: swap did not reach target price within tolerance")]
    PriceNotReached,
}

#[event]
pub struct SwapExecuted {
    pub from_sqrt_price: u128,
    pub to_sqrt_price: u128,
    pub actual_sqrt_price: u128,
}
