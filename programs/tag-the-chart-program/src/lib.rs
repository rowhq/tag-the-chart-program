use anchor_lang::prelude::*;

mod instructions;
mod state;

use instructions::*;

declare_id!("75SUaVzpGhU8R1TGJeS4zK4vBWWr1YtAQtWbNwY2C2or");

#[program]
pub mod tag_the_chart_program {
    use super::*;

    /// Initialize a trading account (PDA) for a user
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::initialize(ctx)
    }

    /// Deposit native SOL into trading account
    pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
        instructions::deposit::deposit_sol(ctx, amount)
    }

    /// Deposit Token2022 tokens into trading account
    pub fn deposit_tokens(ctx: Context<DepositTokens>, amount: u64) -> Result<()> {
        instructions::deposit::deposit_tokens(ctx, amount)
    }

    /// Withdraw native SOL from trading account
    pub fn withdraw_sol(ctx: Context<WithdrawSol>, amount: u64) -> Result<()> {
        instructions::withdraw::withdraw_sol(ctx, amount)
    }

    /// Withdraw Token2022 tokens from trading account
    pub fn withdraw_tokens(ctx: Context<WithdrawTokens>, amount: u64) -> Result<()> {
        instructions::withdraw::withdraw_tokens(ctx, amount)
    }

    /// Execute a candle pattern (3 atomic swaps in one transaction)
    pub fn swap_to_prices<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapCandle<'info>>,
        target_sqrt_prices: [u128; 3],
        slippage_bps: u16,
    ) -> Result<()> {
        instructions::swap::swap_to_prices(ctx, target_sqrt_prices, slippage_bps)
    }
}
