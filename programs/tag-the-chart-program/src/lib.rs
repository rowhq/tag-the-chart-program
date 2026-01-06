use anchor_lang::prelude::*;

mod instructions;
mod state;

use instructions::*;

declare_id!("47z6kVAxM8LxGqSgFHXyMq3eK4Lq2U7TQXLpV3bjPtdD");

#[program]
pub mod tag_the_chart_program {
    use super::*;

    /// Initialize a trading account (PDA) for a user
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::initialize(ctx)
    }

    /// Execute a candle pattern (3 atomic swaps in one transaction)
    pub fn swap_to_prices<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapCandle<'info>>,
        target_sqrt_prices: [u128; 3],
        max_inputs: [u64; 3],
        min_outputs: [u64; 3],
    ) -> Result<()> {
        instructions::swap::swap_to_prices(ctx, target_sqrt_prices, max_inputs, min_outputs)
    }

    /// Deposit tokens (SPL Token or Token-2022, including WSOL)
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::deposit(ctx, amount)
    }

    /// Withdraw tokens (SPL Token or Token-2022, including WSOL)
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::withdraw(ctx, amount)
    }
}
