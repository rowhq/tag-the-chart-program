use anchor_lang::prelude::*;

/// Trading Account PDA - holds user funds for pattern execution
/// Think of this like a smart contract wallet

#[account]
pub struct TradingAccount {
    /// The user who owns this trading account
    pub owner: Pubkey,

    /// Bump seed for PDA derivation
    pub bump: u8,
}

impl TradingAccount {
    /// Size calculation for account allocation
    /// 8 (discriminator) + 32 (owner) + 1 (bump)
    pub const LEN: usize = 8 + 32 + 1;
}
