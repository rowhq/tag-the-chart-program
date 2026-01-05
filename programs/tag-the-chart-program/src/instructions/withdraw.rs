use crate::state::TradingAccount;
use anchor_lang::prelude::*;
use anchor_spl::token;
use anchor_spl::token_2022;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

/// Withdraw tokens from PDA-owned token account to user's wallet
///
/// This transfers tokens from the PDA-owned token account back to the user.
/// PDA signs the transfer using its seeds.
/// Works with both SPL Token and Token-2022, including WSOL.
/// Use this for withdrawing already-wrapped WSOL.
pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);

    // Check sufficient balance
    let balance = ctx.accounts.pda_token_account.amount;
    require!(balance >= amount, ErrorCode::InsufficientBalance);

    let user_key = ctx.accounts.user.key();
    let bump = ctx.accounts.trading_account.bump;

    // PDA seeds for signing
    let seeds = &[b"trading_account", user_key.as_ref(), &[bump]];
    let signer = &[&seeds[..]];

    // Transfer tokens from PDA-owned token account to user's token account
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token_interface::TransferChecked {
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
pub struct Withdraw<'info> {
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
        constraint = *pda_token_account.to_account_info().owner == token_program.key() @ ErrorCode::InvalidTokenAccountOwner
    )]
    pub pda_token_account: InterfaceAccount<'info, TokenAccount>,

    /// User's destination token account
    #[account(
        mut,
        token::authority = user,
        token::mint = mint,
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Token mint (works with both SPL Token and Token-2022)
    pub mint: InterfaceAccount<'info, Mint>,

    /// Token program (SPL Token or Token-2022)
    #[account(
        constraint = token_program.key() == token::ID
            || token_program.key() == token_2022::ID
            @ ErrorCode::InvalidTokenProgram
    )]
    pub token_program: Interface<'info, TokenInterface>,
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
    #[msg("Invalid token program: must be SPL Token or Token-2022")]
    InvalidTokenProgram,
    #[msg("Invalid token account owner: must be owned by the token program")]
    InvalidTokenAccountOwner,
}
