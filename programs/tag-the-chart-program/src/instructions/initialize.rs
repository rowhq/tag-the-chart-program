use crate::state::TradingAccount;
use anchor_lang::prelude::*;

/// Initialize a trading account (PDA) for a user
///
/// In Ethereum terms: This is like deploying a smart contract wallet
/// for the user. The PDA address is deterministic based on the user's pubkey.
pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
    let trading_account = &mut ctx.accounts.trading_account;

    // Initialize the account state
    trading_account.owner = ctx.accounts.user.key();
    trading_account.bump = ctx.bumps.trading_account;

    msg!(
        "Trading account initialized for user: {}",
        ctx.accounts.user.key()
    );

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// The PDA account that will store user's trading funds
    /// Seeds: ["trading_account", user.key()]
    /// This makes the address deterministic - same user always gets same PDA
    #[account(
        init,
        payer = user,
        space = TradingAccount::LEN,
        seeds = [b"trading_account", user.key().as_ref()],
        bump
    )]
    pub trading_account: Account<'info, TradingAccount>,

    pub system_program: Program<'info, System>,
}
