use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("EWAGERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

#[program]
pub mod ewager_escrow {
    use super::*;

    /// Initialize the protocol with configuration parameters
    /// Only called once during deployment
    pub fn initialize(
        ctx: Context<Initialize>,
        fee_bps: u16,
        creator_fee_share: u8,
    ) -> Result<()> {
        require!(fee_bps <= 1000, ErrorCode::FeeTooHigh); // Max 10%
        require!(creator_fee_share <= 100, ErrorCode::InvalidFeeShare);
        
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.treasury = ctx.accounts.treasury.key();
        config.fee_bps = fee_bps;
        config.creator_fee_share = creator_fee_share;
        config.paused = false;
        config.bump = ctx.bumps.config;
        
        msg!("Protocol initialized with {}% fee", fee_bps as f64 / 100.0);
        Ok(())
    }

    /// Create a new wager and lock creator's funds in escrow
    /// opponent = SystemProgram::id() for open wagers
    pub fn create_wager(
        ctx: Context<CreateWager>,
        wager_id: u64,
        amount: u64,
        opponent: Pubkey,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, ErrorCode::ProtocolPaused);
        require!(amount > 0, ErrorCode::InvalidAmount);
        
        let wager = &mut ctx.accounts.wager;
        let clock = Clock::get()?;
        
        wager.id = wager_id;
        wager.creator = ctx.accounts.creator.key();
        wager.opponent = opponent;
        wager.amount = amount;
        wager.escrow = ctx.accounts.escrow.key();
        wager.status = WagerStatus::Open;
        wager.winner = Pubkey::default();
        wager.created_at = clock.unix_timestamp;
        wager.accepted_at = 0;
        wager.settled_at = 0;
        wager.bump = ctx.bumps.wager;
        
        // Transfer tokens from creator to escrow
        let cpi_accounts = Transfer {
            from: ctx.accounts.creator_token_account.to_account_info(),
            to: ctx.accounts.escrow.to_account_info(),
            authority: ctx.accounts.creator.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
        );
        token::transfer(cpi_ctx, amount)?;
        
        msg!("Wager {} created by {} for {} tokens", wager_id, ctx.accounts.creator.key(), amount);
        Ok(())
    }

    /// Accept an open wager and lock opponent's funds
    /// Changes status from Open to Active
    pub fn accept_wager(ctx: Context<AcceptWager>) -> Result<()> {
        require!(!ctx.accounts.config.paused, ErrorCode::ProtocolPaused);
        
        let wager = &mut ctx.accounts.wager;
        require!(wager.status == WagerStatus::Open, ErrorCode::WagerNotOpen);
        
        // Verify opponent eligibility (either open wager or specific opponent)
        let is_open_wager = wager.opponent == System::id();
        let is_designated_opponent = wager.opponent == ctx.accounts.opponent.key();
        require!(
            is_open_wager || is_designated_opponent,
            ErrorCode::UnauthorizedOpponent
        );
        
        let clock = Clock::get()?;
        wager.opponent = ctx.accounts.opponent.key();
        wager.status = WagerStatus::Active;
        wager.accepted_at = clock.unix_timestamp;
        
        // Transfer tokens from opponent to escrow
        let cpi_accounts = Transfer {
            from: ctx.accounts.opponent_token_account.to_account_info(),
            to: ctx.accounts.escrow.to_account_info(),
            authority: ctx.accounts.opponent.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
        );
        token::transfer(cpi_ctx, wager.amount)?;
        
        msg!("Wager {} accepted by {}", wager.id, ctx.accounts.opponent.key());
        Ok(())
    }

    /// Settle a completed wager - distribute funds to winner and collect fees
    /// Only callable by protocol authority after verification
    pub fn settle_wager(ctx: Context<SettleWager>, winner: Pubkey) -> Result<()> {
        let wager = &mut ctx.accounts.wager;
        require!(wager.status == WagerStatus::Active, ErrorCode::WagerNotActive);
        require!(
            winner == wager.creator || winner == wager.opponent,
            ErrorCode::InvalidWinner
        );
        
        let config = &ctx.accounts.config;
        let total_pot = wager.amount.checked_mul(2).unwrap();
        
        // Calculate fees
        let total_fee = total_pot
            .checked_mul(config.fee_bps as u64).unwrap()
            .checked_div(10000).unwrap();
        let creator_fee = total_fee
            .checked_mul(config.creator_fee_share as u64).unwrap()
            .checked_div(100).unwrap();
        let treasury_fee = total_fee.checked_sub(creator_fee).unwrap();
        let winner_amount = total_pot.checked_sub(total_fee).unwrap();
        
        // Derive PDA seeds for signing
        let wager_id_bytes = wager.id.to_le_bytes();
        let seeds = &[
            b"wager",
            wager_id_bytes.as_ref(),
            &[wager.bump],
        ];
        let signer = &[&seeds[..]];
        
        // Transfer to winner
        let winner_cpi_accounts = Transfer {
            from: ctx.accounts.escrow.to_account_info(),
            to: ctx.accounts.winner_token_account.to_account_info(),
            authority: ctx.accounts.wager.to_account_info(),
        };
        let winner_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            winner_cpi_accounts,
            signer,
        );
        token::transfer(winner_cpi_ctx, winner_amount)?;
        
        // Transfer creator fee
        let creator_fee_cpi_accounts = Transfer {
            from: ctx.accounts.escrow.to_account_info(),
            to: ctx.accounts.creator_fee_account.to_account_info(),
            authority: ctx.accounts.wager.to_account_info(),
        };
        let creator_fee_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            creator_fee_cpi_accounts,
            signer,
        );
        token::transfer(creator_fee_cpi_ctx, creator_fee)?;
        
        // Transfer treasury fee
        let treasury_fee_cpi_accounts = Transfer {
            from: ctx.accounts.escrow.to_account_info(),
            to: ctx.accounts.treasury_token_account.to_account_info(),
            authority: ctx.accounts.wager.to_account_info(),
        };
        let treasury_fee_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            treasury_fee_cpi_accounts,
            signer,
        );
        token::transfer(treasury_fee_cpi_ctx, treasury_fee)?;
        
        // Update wager state
        let clock = Clock::get()?;
        wager.winner = winner;
        wager.status = WagerStatus::Settled;
        wager.settled_at = clock.unix_timestamp;
        
        msg!(
            "Wager {} settled - Winner: {}, Amount: {}, Fees: {}",
            wager.id,
            winner,
            winner_amount,
            total_fee
        );
        Ok(())
    }

    /// Cancel an open wager if no opponent joins within 24 hours
    /// Returns creator's funds
    pub fn cancel_wager(ctx: Context<CancelWager>) -> Result<()> {
        let wager = &mut ctx.accounts.wager;
        require!(wager.status == WagerStatus::Open, ErrorCode::WagerNotOpen);
        require!(
            ctx.accounts.creator.key() == wager.creator,
            ErrorCode::UnauthorizedCancellation
        );
        
        let clock = Clock::get()?;
        let elapsed = clock.unix_timestamp - wager.created_at;
        require!(elapsed >= 86400, ErrorCode::CancellationTooEarly); // 24 hours
        
        // Refund creator
        let wager_id_bytes = wager.id.to_le_bytes();
        let seeds = &[
            b"wager",
            wager_id_bytes.as_ref(),
            &[wager.bump],
        ];
        let signer = &[&seeds[..]];
        
        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow.to_account_info(),
            to: ctx.accounts.creator_token_account.to_account_info(),
            authority: ctx.accounts.wager.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, wager.amount)?;
        
        wager.status = WagerStatus::Cancelled;
        msg!("Wager {} cancelled and refunded", wager.id);
        Ok(())
    }

    /// Update protocol fee configuration (admin only)
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        fee_bps: Option<u16>,
        creator_fee_share: Option<u8>,
        paused: Option<bool>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        
        if let Some(fee) = fee_bps {
            require!(fee <= 1000, ErrorCode::FeeTooHigh);
            config.fee_bps = fee;
            msg!("Fee updated to {}%", fee as f64 / 100.0);
        }
        
        if let Some(share) = creator_fee_share {
            require!(share <= 100, ErrorCode::InvalidFeeShare);
            config.creator_fee_share = share;
            msg!("Creator fee share updated to {}%", share);
        }
        
        if let Some(pause) = paused {
            config.paused = pause;
            msg!("Protocol paused: {}", pause);
        }
        
        Ok(())
    }
}

// ===========================
// ACCOUNT STRUCTURES
// ===========================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolConfig::SIZE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    /// CHECK: Treasury wallet can be any pubkey
    pub treasury: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(wager_id: u64, amount: u64)]
pub struct CreateWager<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    
    #[account(
        init,
        payer = creator,
        space = 8 + Wager::SIZE,
        seeds = [b"wager", wager_id.to_le_bytes().as_ref()],
        bump
    )]
    pub wager: Account<'info, Wager>,
    
    #[account(
        init,
        payer = creator,
        token::mint = mint,
        token::authority = wager,
        seeds = [b"escrow", wager_id.to_le_bytes().as_ref()],
        bump
    )]
    pub escrow: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub creator: Signer<'info>,
    
    #[account(
        mut,
        constraint = creator_token_account.owner == creator.key(),
        constraint = creator_token_account.mint == mint.key()
    )]
    pub creator_token_account: Account<'info, TokenAccount>,
    
    /// CHECK: EWAGER token mint
    pub mint: AccountInfo<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AcceptWager<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    
    #[account(
        mut,
        seeds = [b"wager", wager.id.to_le_bytes().as_ref()],
        bump = wager.bump
    )]
    pub wager: Account<'info, Wager>,
    
    #[account(
        mut,
        constraint = escrow.key() == wager.escrow
    )]
    pub escrow: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub opponent: Signer<'info>,
    
    #[account(
        mut,
        constraint = opponent_token_account.owner == opponent.key(),
        constraint = opponent_token_account.mint == escrow.mint
    )]
    pub opponent_token_account: Account<'info, TokenAccount>,
    
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleWager<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    
    #[account(
        mut,
        seeds = [b"wager", wager.id.to_le_bytes().as_ref()],
        bump = wager.bump
    )]
    pub wager: Account<'info, Wager>,
    
    #[account(
        mut,
        constraint = escrow.key() == wager.escrow
    )]
    pub escrow: Account<'info, TokenAccount>,
    
    #[account(
        constraint = authority.key() == config.authority
    )]
    pub authority: Signer<'info>,
    
    #[account(mut)]
    pub winner_token_account: Account<'info, TokenAccount>,
    
    /// CHECK: Creator wallet (can be wager creator or separate creator)
    pub creator: AccountInfo<'info>,
    
    #[account(
        mut,
        constraint = creator_fee_account.owner == creator.key()
    )]
    pub creator_fee_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = treasury_token_account.owner == config.treasury
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,
    
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelWager<'info> {
    #[account(
        mut,
        seeds = [b"wager", wager.id.to_le_bytes().as_ref()],
        bump = wager.bump
    )]
    pub wager: Account<'info, Wager>,
    
    #[account(
        mut,
        constraint = escrow.key() == wager.escrow
    )]
    pub escrow: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = creator.key() == wager.creator
    )]
    pub creator: Signer<'info>,
    
    #[account(mut)]
    pub creator_token_account: Account<'info, TokenAccount>,
    
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    
    #[account(
        constraint = authority.key() == config.authority
    )]
    pub authority: Signer<'info>,
}

// ===========================
// STATE STRUCTURES
// ===========================

#[account]
pub struct ProtocolConfig {
    pub authority: Pubkey,        // 32
    pub treasury: Pubkey,          // 32
    pub fee_bps: u16,              // 2 (basis points: 500 = 5%)
    pub creator_fee_share: u8,     // 1 (percentage: 60 = 60%)
    pub paused: bool,              // 1
    pub bump: u8,                  // 1
}

impl ProtocolConfig {
    pub const SIZE: usize = 32 + 32 + 2 + 1 + 1 + 1;
}

#[account]
pub struct Wager {
    pub id: u64,                   // 8
    pub creator: Pubkey,           // 32
    pub opponent: Pubkey,          // 32
    pub amount: u64,               // 8
    pub escrow: Pubkey,            // 32
    pub status: WagerStatus,       // 1
    pub winner: Pubkey,            // 32
    pub created_at: i64,           // 8
    pub accepted_at: i64,          // 8
    pub settled_at: i64,           // 8
    pub bump: u8,                  // 1
}

impl Wager {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 32 + 1 + 32 + 8 + 8 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum WagerStatus {
    Open,       // Waiting for opponent
    Active,     // Both players locked in
    Settled,    // Winner paid out
    Cancelled,  // Refunded to creator
}

// ===========================
// ERROR CODES
// ===========================

#[error_code]
pub enum ErrorCode {
    #[msg("Protocol is currently paused")]
    ProtocolPaused,
    
    #[msg("Fee cannot exceed 10%")]
    FeeTooHigh,
    
    #[msg("Creator fee share must be 0-100")]
    InvalidFeeShare,
    
    #[msg("Wager amount must be greater than zero")]
    InvalidAmount,
    
    #[msg("Wager is not in Open status")]
    WagerNotOpen,
    
    #[msg("Wager is not in Active status")]
    WagerNotActive,
    
    #[msg("Only designated opponent can accept this wager")]
    UnauthorizedOpponent,
    
    #[msg("Winner must be either creator or opponent")]
    InvalidWinner,
    
    #[msg("Only wager creator can cancel")]
    UnauthorizedCancellation,
    
    #[msg("Wager can only be cancelled after 24 hours")]
    CancellationTooEarly,
}
