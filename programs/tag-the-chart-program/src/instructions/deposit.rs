use crate::state::TradingAccount;
use anchor_lang::prelude::*;
use anchor_spl::token;
use anchor_spl::token_2022;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

/// Deposit tokens into PDA-owned token account
///
/// This transfers tokens from user's wallet to a PDA-owned token account.
/// Works with both SPL Token and Token-2022, including WSOL.
/// Use this for depositing already-wrapped WSOL.
pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);

    // Transfer tokens from user's token account to PDA-owned token account
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token_interface::TransferChecked {
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

#[derive(Accounts)]
pub struct Deposit<'info> {
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
        constraint = *pda_token_account.to_account_info().owner == token_program.key() @ ErrorCode::InvalidTokenAccountOwner
    )]
    pub pda_token_account: InterfaceAccount<'info, TokenAccount>,

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
    #[msg("Unauthorized: You don't own this trading account")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid token program: must be SPL Token or Token-2022")]
    InvalidTokenProgram,
    #[msg("Invalid token account owner: must be owned by the token program")]
    InvalidTokenAccountOwner,
}
