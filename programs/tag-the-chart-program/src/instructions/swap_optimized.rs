use crate::state::TradingAccount;
use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount};
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

declare_id!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

pub fn swap_to_prices<'info>(
    ctx: Context<'_, '_, '_, 'info, SwapCandle<'info>>,
    target_sqrt_prices: [u128; 3], // Target sqrt prices (X64 format) for each swap
    slippage_bps: u16,             // Slippage tolerance in basis points (e.g., 50 = 0.5%)
) -> Result<()> {
    let user_key = ctx.accounts.user.key();
    let bump = ctx.accounts.trading_account.bump;

    let seeds = &[b"trading_account", user_key.as_ref(), &[bump]];
    let signer = &[&seeds[..]];

    for (_, target_sqrt_price) in target_sqrt_prices.iter().enumerate() {
        // Read current sqrt price directly from pool state bytes
        // PoolState has sqrt_price_x64 at byte offset 253 (field offset 245 after discriminator)
        let pool_data = ctx.accounts.pool_state.try_borrow_data()?;

        // Ensure we have enough data
        require!(pool_data.len() >= 269, ErrorCode::InvalidPoolData);

        // Read sqrt_price_x64 (u128) from bytes 253-268
        let mut sqrt_price_bytes = [0u8; 16];
        sqrt_price_bytes.copy_from_slice(&pool_data[253..269]);
        let current_sqrt_price = u128::from_le_bytes(sqrt_price_bytes);

        drop(pool_data);

        let price_increasing = *target_sqrt_price > current_sqrt_price;
        let a_to_b = !price_increasing;

        swap_to_target_price(&ctx, signer, *target_sqrt_price, a_to_b, slippage_bps)?;
    }

    Ok(())
}

/// Uses a large input amount and relies on sqrt_price_limit to stop at target price.
/// Raydium will calculate the exact amount needed and only swap what's necessary.
fn swap_to_target_price<'info>(
    ctx: &Context<'_, '_, '_, 'info, SwapCandle<'info>>,
    signer_seeds: &[&[&[u8]]],
    target_sqrt_price: u128,
    a_to_b: bool,
    _: u16, // slippage_bps
) -> Result<()> {
    let amount_specified = u64::MAX; //
    let minimum_amount_out = 0u64;

    // Determine which vault holds WSOL by checking mint addresses
    // WSOL mint: So11111111111111111111111111111111111111112

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

    // Build swap_v2 instruction manually
    // Discriminator: SHA256("global:swap_v2")[0..8] = [43, 4, 237, 11, 26, 201, 30, 98]
    let mut ix_data = Vec::with_capacity(41);
    ix_data.extend_from_slice(&[43, 4, 237, 11, 26, 201, 30, 98]); // discriminator
    ix_data.extend_from_slice(&amount_specified.to_le_bytes());      // amount_specified: u64
    ix_data.extend_from_slice(&minimum_amount_out.to_le_bytes());    // minimum_amount_out: u64
    ix_data.extend_from_slice(&target_sqrt_price.to_le_bytes());     // sqrt_price_limit: u128
    ix_data.push(1u8);                                                // is_base_input: bool (true)

    // Build accounts list for swap_v2
    let mut accounts = vec![
        AccountMeta::new(ctx.accounts.trading_account.key(), true),      // payer
        AccountMeta::new_readonly(ctx.accounts.amm_config.key(), false), // amm_config
        AccountMeta::new(ctx.accounts.pool_state.key(), false),          // pool_state
        AccountMeta::new(input_token_account.key(), false),              // input_token_account
        AccountMeta::new(output_token_account.key(), false),             // output_token_account
        AccountMeta::new(input_vault.key(), false),                      // input_vault
        AccountMeta::new(output_vault.key(), false),                     // output_vault
        AccountMeta::new(ctx.accounts.observation_state.key(), false),   // observation_state
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),      // token_program
        AccountMeta::new_readonly(ctx.accounts.token_program_2022.key(), false), // token_program_2022
        AccountMeta::new_readonly(ctx.accounts.memo_program.key(), false),       // memo_program
        AccountMeta::new_readonly(input_vault_mint.key(), false),        // input_vault_mint
        AccountMeta::new_readonly(output_vault_mint.key(), false),       // output_vault_mint
    ];

    // Add remaining accounts (tick arrays)
    for remaining_account in ctx.remaining_accounts.iter() {
        accounts.push(AccountMeta::new(remaining_account.key(), false));
    }

    let swap_ix = Instruction {
        program_id: ctx.accounts.raydium_program.key(),
        accounts,
        data: ix_data,
    };

    // Invoke with PDA signer
    let account_infos = [
        ctx.accounts.trading_account.to_account_info(),
        ctx.accounts.amm_config.to_account_info(),
        ctx.accounts.pool_state.to_account_info(),
        input_token_account,
        output_token_account,
        input_vault,
        output_vault,
        ctx.accounts.observation_state.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.token_program_2022.to_account_info(),
        ctx.accounts.memo_program.to_account_info(),
        input_vault_mint,
        output_vault_mint,
        ctx.accounts.raydium_program.to_account_info(),
    ];

    let mut all_account_infos = account_infos.to_vec();
    all_account_infos.extend_from_slice(ctx.remaining_accounts);

    invoke_signed(&swap_ix, &all_account_infos, signer_seeds)?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(target_sqrt_prices: [u128; 3], slippage_bps: u16)]
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

    /// CHECK: Raydium CLMM program (devnet or mainnet)
    #[account(executable)]
    pub raydium_program: AccountInfo<'info>,

    /// CHECK: AMM config account validated by Raydium CLMM
    pub amm_config: AccountInfo<'info>,

    /// CHECK: Pool state account validated by Raydium CLMM
    #[account(mut)]
    pub pool_state: AccountInfo<'info>,

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
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid pool data")]
    InvalidPoolData,
}
