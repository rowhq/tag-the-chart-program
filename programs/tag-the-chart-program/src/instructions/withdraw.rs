use crate::state::TradingAccount;
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_2022::{self, Token2022};
use anchor_spl::token_interface::{Mint, TokenAccount};

/// Withdraw SOL from the trading account PDA back to user's wallet
///
/// This allows users to withdraw their funds anytime.
/// Non-custodial - user maintains full control.
pub fn withdraw_sol(ctx: Context<WithdrawSol>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);

    // Check PDA has enough lamports (including rent-exempt minimum)
    let pda_lamports = ctx.accounts.trading_account.to_account_info().lamports();
    let rent_exempt_min = Rent::get()?.minimum_balance(TradingAccount::LEN);
    let available = pda_lamports.checked_sub(rent_exempt_min).unwrap_or(0);

    require!(available >= amount, ErrorCode::InsufficientBalance);

    // PDA seeds for signing the transfer
    let user_key = ctx.accounts.user.key();
    let bump = ctx.accounts.trading_account.bump;
    let seeds = &[b"trading_account", user_key.as_ref(), &[bump]];
    let signer = &[&seeds[..]];

    // Transfer SOL from PDA to user using system program
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.trading_account.to_account_info(),
                to: ctx.accounts.user.to_account_info(),
            },
            signer,
        ),
        amount,
    )?;

    msg!("Withdrawn {} lamports from trading account", amount);

    Ok(())
}

/// Withdraw Token2022 tokens from PDA-owned token account to user's wallet
///
/// This transfers tokens from the PDA-owned token account back to the user.
/// PDA signs the transfer using its seeds.
pub fn withdraw_tokens(ctx: Context<WithdrawTokens>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);

    let user_key = ctx.accounts.user.key();
    let bump = ctx.accounts.trading_account.bump;

    // PDA seeds for signing
    let seeds = &[b"trading_account", user_key.as_ref(), &[bump]];
    let signer = &[&seeds[..]];

    // Transfer tokens from PDA-owned token account to user's token account
    token_2022::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token_2022::TransferChecked {
                from: ctx.accounts.pda_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.trading_account.to_account_info(),
            },
            signer,
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
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
pub struct WithdrawTokens<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// The user's trading account PDA (for validation)
    #[account(
        seeds = [b"trading_account", user.key().as_ref()],
        bump = trading_account.bump,
        constraint = trading_account.owner  == user.key() @ ErrorCode::Unauthorized
    )]
    pub trading_account: Account<'info, TradingAccount>,

    /// PDA-owned source token account
    #[account(
        mut,
        token::authority = trading_account,
        token::mint = mint,
    )]
    pub pda_token_account: InterfaceAccount<'info, TokenAccount>,

    /// User's destination token account
    #[account(
        mut,
        token::authority = user,
        token::mint = mint,
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Token mint (Token2022)
    pub mint: InterfaceAccount<'info, Mint>,

    /// Token2022 program
    pub token_program: Program<'info, Token2022>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Amount must be greater than 0")]
    InvalidAmount,
    #[msg("Insufficient balance in trading account")]
    InsufficientBalance,
    #[msg("Unauthorized: You don't own this trading account")]
    Unauthorized,
    #[msg("Arithmetic underflow")]
    Underflow,
}
