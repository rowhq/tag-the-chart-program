use crate::state::TradingAccount;
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_2022::{self, Token2022};
use anchor_spl::token_interface::{Mint, TokenAccount};

/// Deposit Token2022 tokens into PDA-owned token account
///
/// This transfers tokens from user's wallet to a PDA-owned token account.
/// Only supports Token2022 (modern standard).
pub fn deposit_tokens(ctx: Context<DepositTokens>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);

    // Transfer tokens from user's token account to PDA-owned token account
    token_2022::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token_2022::TransferChecked {
                from: ctx.accounts.user_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.pda_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    Ok(())
}

/// Deposit native SOL into the trading account PDA
///
/// For SOL pairs (e.g., SOL/USDC), deposit native SOL instead of wrapped SOL.
/// The PDA will hold SOL lamports directly.
pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);

    // Transfer SOL from user to trading account PDA
    // Balance automatically tracked by PDA account's lamports
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.trading_account.to_account_info(),
            },
        ),
        amount,
    )?;

    msg!("Deposited {} lamports (SOL) to trading account", amount);

    Ok(())
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// The user's trading account PDA
    #[account(
        mut,
        seeds = [b"trading_account", user.key().as_ref()],
        bump = trading_account.bump,
        constraint = trading_account.owner  == user.key() @ ErrorCode::Unauthorized
    )]
    pub trading_account: Account<'info, TradingAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositTokens<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// The user's trading account PDA (for validation)
    #[account(
        seeds = [b"trading_account", user.key().as_ref()],
        bump = trading_account.bump,
        constraint = trading_account.owner  == user.key() @ ErrorCode::Unauthorized
    )]
    pub trading_account: Account<'info, TradingAccount>,

    /// User's source token account
    #[account(
        mut,
        token::authority = user,
        token::mint = mint,
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    /// PDA-owned destination token account
    /// Must be owned by the trading account PDA
    #[account(
        mut,
        token::authority = trading_account,
        token::mint = mint,
    )]
    pub pda_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Token mint (Token2022)
    pub mint: InterfaceAccount<'info, Mint>,

    /// Token2022 program
    pub token_program: Program<'info, Token2022>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Amount must be greater than 0")]
    InvalidAmount,
    #[msg("Unauthorized: You don't own this trading account")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
}
