use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount};
use raydium_amm_v3::{
    cpi,
    libraries::swap_math,
    program::AmmV3,
    states::{AmmConfig, PoolState},
};

declare_id!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// Execute 3 atomic swaps to create OHLC candle pattern
/// Simplified version without PDA - uses wallet's ATAs directly
pub fn swap_to_prices_simple<'info>(
    ctx: Context<'_, '_, '_, 'info, SwapCandleSimple<'info>>,
    to_sqrt_prices: [u128; 3], // Target sqrt prices (X64 format) for each swap
    max_inputs: [u64; 3],      // Max input amounts (0 = no limit)
    min_outputs: [u64; 3],     // Min output amounts (0 = no limit)
) -> Result<()> {
    require_valid_wsol_ata(&ctx)?;

    // Execute swaps
    for (i, to_sqrt_price) in to_sqrt_prices.iter().enumerate() {
        let from_sqrt_price = {
            let pool = ctx.accounts.pool_state.load()?;
            pool.sqrt_price_x64
        };

        let a_for_b = !(*to_sqrt_price > from_sqrt_price);
        swap_to_price(&ctx, *to_sqrt_price, a_for_b, max_inputs[i], min_outputs[i])?;

        require_price_reached(&ctx, from_sqrt_price, *to_sqrt_price)?;
    }

    Ok(())
}

/// Execute a single swap to target price
fn swap_to_price<'info>(
    ctx: &Context<'_, '_, '_, 'info, SwapCandleSimple<'info>>,
    to_sqrt_price: u128,
    a_for_b: bool,
    max_in: u64,
    min_out: u64,
) -> Result<()> {
    let (amount_in, amount_out) = get_amount_in(ctx, to_sqrt_price, a_for_b, max_in, min_out)?;

    wrap_sol(ctx, amount_in, a_for_b)?;

    // Build CPI accounts for Raydium swap
    let cpi_accounts = build_swap_cpi_accounts(ctx, a_for_b);
    let program = ctx.accounts.raydium_program.to_account_info();
    let cpi_ctx = CpiContext::new(program, cpi_accounts)
        .with_remaining_accounts(ctx.remaining_accounts.to_vec());

    // Execute swap_v2 with target sqrt price as limit
    cpi::swap_v2(
        cpi_ctx,
        amount_in,
        amount_out,
        to_sqrt_price,
        true, // is_base_input
    )?;

    emit!(Swap {
        a_for_b,
        amount_in,
        amount_out,
    });

    Ok(())
}

/// Calculate exact input amount needed to reach target price
fn get_amount_in<'info>(
    ctx: &Context<'_, '_, '_, 'info, SwapCandleSimple<'info>>,
    to_sqrt_price: u128,
    a_for_b: bool,
    max_in: u64,
    min_out: u64,
) -> Result<(u64, u64)> {
    // Get current pool state

    let amount_remaining = if max_in == 0 { u64::MAX } else { max_in };

    let pool = ctx.accounts.pool_state.load()?;
    let current_sqrt_price = pool.sqrt_price_x64;
    let liquidity = pool.liquidity;
    drop(pool);

    // Get amm config for fee rate
    let fee_rate = ctx.accounts.amm_config.trade_fee_rate;

    // Get current timestamp
    let clock = Clock::get()?;
    let block_timestamp = clock.unix_timestamp as u32;

    // Use Raydium's compute_swap_step to calculate exact amount
    let swap_step = swap_math::compute_swap_step(
        current_sqrt_price,
        to_sqrt_price,
        liquidity,
        amount_remaining,
        fee_rate,
        true,
        a_for_b,
        block_timestamp,
    )?;

    Ok((swap_step.amount_in, swap_step.amount_out.min(min_out)))
}

/// Wrap SOL to WSOL if this swap requires it
fn wrap_sol<'info>(
    ctx: &Context<'_, '_, '_, 'info, SwapCandleSimple<'info>>,
    amount: u64,
    a_for_b: bool,
) -> Result<()> {
    let is_mint_a_wsol = ctx.accounts.token_mint_a.key() == WSOL_MINT;
    let need_to_wrap = (a_for_b && is_mint_a_wsol) || (!a_for_b && !is_mint_a_wsol);

    if !need_to_wrap {
        return Ok(());
    }

    // Get the WSOL mint account (either mint_a or mint_b)
    let wsol_mint_account = if is_mint_a_wsol {
        ctx.accounts.token_mint_a.to_account_info()
    } else {
        ctx.accounts.token_mint_b.to_account_info()
    };

    let wsol_ata_info = ctx.accounts.wsol_ata.to_account_info();
    if wsol_ata_info.data_is_empty() {
        anchor_spl::associated_token::create(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            anchor_spl::associated_token::Create {
                payer: ctx.accounts.wallet.to_account_info(),
                associated_token: wsol_ata_info.clone(),
                authority: ctx.accounts.wallet.to_account_info(),
                mint: wsol_mint_account.clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;
    }

    let wrap_amount = amount + 1000; // +1000 lamports buffer

    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.wallet.to_account_info(),
                to: wsol_ata_info.clone(),
            },
        ),
        wrap_amount,
    )?;

    anchor_spl::token::sync_native(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        anchor_spl::token::SyncNative {
            account: wsol_ata_info,
        },
    ))?;

    Ok(())
}

/// Build CPI accounts for Raydium swap based on swap direction
fn build_swap_cpi_accounts<'info>(
    ctx: &Context<'_, '_, '_, 'info, SwapCandleSimple<'info>>,
    a_for_b: bool,
) -> cpi::accounts::SwapSingleV2<'info> {
    let is_mint_a_wsol = ctx.accounts.token_mint_a.key() == WSOL_MINT;

    // Determine input/output token accounts based on swap direction
    let (input_token_account, output_token_account) = if a_for_b {
        if is_mint_a_wsol {
            (
                ctx.accounts.wsol_ata.to_account_info(),
                ctx.accounts.spl_ata.to_account_info(),
            )
        } else {
            (
                ctx.accounts.spl_ata.to_account_info(),
                ctx.accounts.wsol_ata.to_account_info(),
            )
        }
    } else {
        if is_mint_a_wsol {
            (
                ctx.accounts.spl_ata.to_account_info(),
                ctx.accounts.wsol_ata.to_account_info(),
            )
        } else {
            (
                ctx.accounts.wsol_ata.to_account_info(),
                ctx.accounts.spl_ata.to_account_info(),
            )
        }
    };

    let (input_vault, output_vault, input_vault_mint, output_vault_mint) = if a_for_b {
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

    cpi::accounts::SwapSingleV2 {
        payer: ctx.accounts.wallet.to_account_info(),
        amm_config: ctx.accounts.amm_config.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        input_token_account,
        output_token_account,
        input_vault,
        output_vault,
        observation_state: ctx.accounts.observation_state.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
        memo_program: ctx.accounts.memo_program.to_account_info(),
        input_vault_mint,
        output_vault_mint,
    }
}

/// Validate that the WSOL ATA provided is correct for the wallet
fn require_valid_wsol_ata<'info>(
    ctx: &Context<'_, '_, '_, 'info, SwapCandleSimple<'info>>,
) -> Result<()> {
    let expected_wsol_ata = get_associated_token_address(&ctx.accounts.wallet.key(), &WSOL_MINT);
    require_keys_eq!(
        ctx.accounts.wsol_ata.key(),
        expected_wsol_ata,
        ErrorCode::InvalidWsolAta
    );
    Ok(())
}

/// Verify that the swap reached the target price within tolerance
fn require_price_reached<'info>(
    ctx: &Context<'_, '_, '_, 'info, SwapCandleSimple<'info>>,
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

    let tolerance = to_sqrt_price / 1000; // 0.1% tolerance
    require!(diff <= tolerance, ErrorCode::PriceNotReached);

    emit!(SwapSqrt {
        from_sqrt_price,
        to_sqrt_price,
        actual_sqrt_price,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(to_sqrt_prices: [u128; 3], max_inputs: [u64; 3], min_outputs: [u64; 3])]
pub struct SwapCandleSimple<'info> {
    /// Wallet that signs and pays for the transaction
    #[account(mut)]
    pub wallet: Signer<'info>,

    /// Wallet's token ATA (non-SOL token)
    #[account(mut)]
    pub spl_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Wallet's WSOL ATA - validated in function
    #[account(mut)]
    pub wsol_ata: UncheckedAccount<'info>,

    /// Raydium CLMM program
    pub raydium_program: Program<'info, AmmV3>,

    /// AMM config account
    pub amm_config: Box<Account<'info, AmmConfig>>,

    /// Pool state account
    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// Pool token vault A
    #[account(mut)]
    pub token_vault_a: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Pool token vault B
    #[account(mut)]
    pub token_vault_b: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Token mint A
    pub token_mint_a: Box<InterfaceAccount<'info, Mint>>,

    /// Token mint B
    pub token_mint_b: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Raydium observation state account - validated by Raydium CPI
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    pub token_program_2022: Program<'info, Token2022>,

    /// CHECK: Memo program
    pub memo_program: UncheckedAccount<'info>,

    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,

    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid WSOL ATA provided")]
    InvalidWsolAta,
    #[msg("Price not reached: swap did not reach target price within tolerance")]
    PriceNotReached,
}

#[event]
pub struct Swap {
    pub a_for_b: bool,
    pub amount_in: u64,
    pub amount_out: u64,
}

#[event]
pub struct SwapSqrt {
    pub from_sqrt_price: u128,
    pub to_sqrt_price: u128,
    pub actual_sqrt_price: u128,
}
