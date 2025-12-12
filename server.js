const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Database configuration
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Initialize database
async function initDatabase() {
  try {
    // Create players table
    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        od_identifier VARCHAR(50) PRIMARY KEY,
        name VARCHAR(20) NOT NULL,
        player_number INT NOT NULL,
        character_image INT NOT NULL DEFAULT 1,
        points INT DEFAULT 10,
        clan_name VARCHAR(30) DEFAULT NULL,
        owner_id VARCHAR(50) DEFAULT NULL,
        daily_revenge_kills INT DEFAULT 0,
        daily_max_streak INT DEFAULT 0,
        daily_challenge_date DATE DEFAULT CURRENT_DATE,
        challenge_revenge_claimed BOOLEAN DEFAULT FALSE,
        challenge_streak_claimed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create clans table
    await db.query(`
      CREATE TABLE IF NOT EXISTS clans (
        name VARCHAR(30) PRIMARY KEY,
        creator_id VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create clan battles table
    await db.query(`
      CREATE TABLE IF NOT EXISTS clan_battles (
        id SERIAL PRIMARY KEY,
        challenger_clan VARCHAR(30) NOT NULL,
        defender_clan VARCHAR(30) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        winner_clan VARCHAR(30) DEFAULT NULL,
        current_round INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create battle rounds table
    await db.query(`
      CREATE TABLE IF NOT EXISTS battle_rounds (
        id SERIAL PRIMARY KEY,
        battle_id INT REFERENCES clan_battles(id),
        round_number INT NOT NULL,
        fighter1_id VARCHAR(50) NOT NULL,
        fighter2_id VARCHAR(50) NOT NULL,
        winner_id VARCHAR(50),
        fighter1_number INT,
        fighter2_number INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Add columns if they don't exist (for existing tables)
    await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS player_number INT DEFAULT 0`).catch(() => {});
    await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS character_image INT DEFAULT 1`).catch(() => {});
    await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS clan_name VARCHAR(30) DEFAULT NULL`).catch(() => {});
    await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS owner_id VARCHAR(50) DEFAULT NULL`).catch(() => {});
    await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS daily_revenge_kills INT DEFAULT 0`).catch(() => {});
    await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS daily_max_streak INT DEFAULT 0`).catch(() => {});
    await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS daily_challenge_date DATE DEFAULT CURRENT_DATE`).catch(() => {});
    await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS challenge_revenge_claimed BOOLEAN DEFAULT FALSE`).catch(() => {});
    await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS challenge_streak_claimed BOOLEAN DEFAULT FALSE`).catch(() => {});
    
    // Rename wins to points if wins column exists
    await db.query(`ALTER TABLE players RENAME COLUMN wins TO points`).catch(() => {});
    
    console.log('Database connected and initialized');
  } catch (err) {
    console.error('Database connection error:', err.message);
    console.log('Running without database - data will not persist');
  }
}

// Active session storage
const players = new Map();

// Revenge tracking: odIdentifier -> { odIdentifier, expiresAt }
const revengeTargets = new Map();

// Heckle messages (last 3)
const heckles = [];

// Generate a random name
function generateName() {
  const adjectives = ['Swift', 'Fierce', 'Shadow', 'Thunder', 'Iron', 'Storm', 'Blazing', 'Silent', 'Crimson', 'Frozen'];
  const nouns = ['Wolf', 'Hawk', 'Viper', 'Bear', 'Tiger', 'Dragon', 'Phoenix', 'Shark', 'Panther', 'Cobra'];
  return `${adjectives[Math.floor(Math.random() * adjectives.length)]}${nouns[Math.floor(Math.random() * nouns.length)]}${Math.floor(Math.random() * 100)}`;
}

// Generate unique player ID
function generatePlayerId() {
  return 'player_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

// Generate random player number (0-99)
function generatePlayerNumber() {
  return Math.floor(Math.random() * 100);
}

// Get or create persistent player from database
async function getOrCreatePlayer(playerId, requestedName) {
  try {
    if (playerId && process.env.DATABASE_URL) {
      const result = await db.query('SELECT * FROM players WHERE od_identifier = $1', [playerId]);
      if (result.rows.length > 0) {
        const player = result.rows[0];
        if (requestedName && requestedName.trim() && requestedName.trim() !== player.name) {
          await db.query('UPDATE players SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE od_identifier = $2', [requestedName.trim(), playerId]);
          player.name = requestedName.trim();
        }
        
        // Reset daily challenges if new day
        const today = new Date().toISOString().split('T')[0];
        const challengeDate = player.daily_challenge_date ? new Date(player.daily_challenge_date).toISOString().split('T')[0] : null;
        if (challengeDate !== today) {
          await db.query(`UPDATE players SET 
            daily_revenge_kills = 0, 
            daily_max_streak = 0, 
            daily_challenge_date = CURRENT_DATE,
            challenge_revenge_claimed = FALSE,
            challenge_streak_claimed = FALSE
            WHERE od_identifier = $1`, [playerId]);
          player.daily_revenge_kills = 0;
          player.daily_max_streak = 0;
          player.challenge_revenge_claimed = false;
          player.challenge_streak_claimed = false;
        }
        
        return { 
          odIdentifier: player.od_identifier, 
          name: player.name, 
          points: player.points,
          playerNumber: player.player_number,
          characterImage: player.character_image || 1,
          clanName: player.clan_name,
          dailyRevengeKills: player.daily_revenge_kills || 0,
          dailyMaxStreak: player.daily_max_streak || 0,
          challengeRevengeClaimed: player.challenge_revenge_claimed || false,
          challengeStreakClaimed: player.challenge_streak_claimed || false,
          isNew: false
        };
      }
    }
    
    // New player - return minimal data, they'll pick character image
    const newId = playerId || generatePlayerId();
    const newName = (requestedName && requestedName.trim()) || generateName();
    const playerNumber = generatePlayerNumber();
    
    return { 
      odIdentifier: newId, 
      name: newName, 
      points: 10, // Start with 10 points
      playerNumber, 
      characterImage: null, // Will be selected by player
      clanName: null,
      dailyRevengeKills: 0,
      dailyMaxStreak: 0,
      challengeRevengeClaimed: false,
      challengeStreakClaimed: false,
      isNew: true 
    };
  } catch (err) {
    console.error('Database error in getOrCreatePlayer:', err.message);
    const newId = playerId || generatePlayerId();
    const newName = (requestedName && requestedName.trim()) || generateName();
    return { odIdentifier: newId, name: newName, points: 10, playerNumber: generatePlayerNumber(), characterImage: 1, clanName: null, dailyRevengeKills: 0, dailyMaxStreak: 0, challengeRevengeClaimed: false, challengeStreakClaimed: false, isNew: true };
  }
}

// Create new player with selected character image
async function createNewPlayer(playerId, name, characterImage) {
  const playerNumber = generatePlayerNumber();
  const validImage = Math.max(1, Math.min(52, characterImage || 1));
  
  if (process.env.DATABASE_URL) {
    try {
      await db.query(
        'INSERT INTO players (od_identifier, name, player_number, character_image, points) VALUES ($1, $2, $3, $4, 10) ON CONFLICT (od_identifier) DO UPDATE SET character_image = $4', 
        [playerId, name, playerNumber, validImage]
      );
    } catch (err) {
      console.error('Error creating player:', err.message);
    }
  }
  
  return { odIdentifier: playerId, name, points: 10, playerNumber, characterImage: validImage, clanName: null, dailyRevengeKills: 0, dailyMaxStreak: 0, challengeRevengeClaimed: false, challengeStreakClaimed: false };
}

// Generate random clan name
function generateClanName() {
  const prefixes = ['Shadow', 'Iron', 'Blood', 'Storm', 'Dark', 'Fire', 'Thunder', 'Frost', 'Night', 'Steel', 'Chaos', 'Savage', 'Ghost', 'War', 'Death'];
  const suffixes = ['Legion', 'Pack', 'Clan', 'Order', 'Brotherhood', 'Horde', 'Alliance', 'Squad', 'Warriors', 'Syndicate', 'Raiders', 'Reapers', 'Knights', 'Wolves', 'Dragons'];
  return `${prefixes[Math.floor(Math.random() * prefixes.length)]} ${suffixes[Math.floor(Math.random() * suffixes.length)]}`;
}

// Create clan for player
async function createClan(odIdentifier, clanName) {
  if (!process.env.DATABASE_URL) return null;
  try {
    const name = clanName && clanName.trim() ? clanName.trim().substring(0, 30) : generateClanName();
    
    // Create clan record with creator
    await db.query('INSERT INTO clans (name, creator_id) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [name, odIdentifier]);
    
    // Update player's clan
    await db.query('UPDATE players SET clan_name = $1, updated_at = CURRENT_TIMESTAMP WHERE od_identifier = $2', [name, odIdentifier]);
    return name;
  } catch (err) {
    console.error('Error creating clan:', err.message);
    return null;
  }
}

// Get clan creator
async function getClanCreator(clanName) {
  if (!process.env.DATABASE_URL || !clanName) return null;
  try {
    const result = await db.query('SELECT creator_id FROM clans WHERE name = $1', [clanName]);
    return result.rows.length > 0 ? result.rows[0].creator_id : null;
  } catch (err) {
    console.error('Error getting clan creator:', err.message);
    return null;
  }
}

// Get all characters owned by a player (including captured ones)
async function getOwnedCharacters(ownerOdIdentifier) {
  if (!process.env.DATABASE_URL) return [];
  try {
    const result = await db.query(
      'SELECT od_identifier, name, points, character_image, clan_name, player_number FROM players WHERE owner_id = $1 OR (owner_id IS NULL AND od_identifier = $1)',
      [ownerOdIdentifier]
    );
    return result.rows;
  } catch (err) {
    console.error('Error getting owned characters:', err.message);
    return [];
  }
}

// Transfer character ownership after capture
async function captureCharacter(capturedId, newClanName, newOwnerId) {
  if (!process.env.DATABASE_URL) return false;
  try {
    await db.query(
      'UPDATE players SET clan_name = $1, owner_id = $2, updated_at = CURRENT_TIMESTAMP WHERE od_identifier = $3',
      [newClanName, newOwnerId, capturedId]
    );
    return true;
  } catch (err) {
    console.error('Error capturing character:', err.message);
    return false;
  }
}

// Create a clan battle challenge
async function createClanBattle(challengerClan, defenderClan) {
  if (!process.env.DATABASE_URL) return null;
  try {
    const result = await db.query(
      'INSERT INTO clan_battles (challenger_clan, defender_clan, status) VALUES ($1, $2, $3) RETURNING id',
      [challengerClan, defenderClan, 'pending']
    );
    return result.rows[0].id;
  } catch (err) {
    console.error('Error creating clan battle:', err.message);
    return null;
  }
}

// Get active clan battle
async function getActiveClanBattle(clanName) {
  if (!process.env.DATABASE_URL) return null;
  try {
    const result = await db.query(
      `SELECT * FROM clan_battles 
       WHERE (challenger_clan = $1 OR defender_clan = $1) 
       AND status IN ('pending', 'accepted', 'in_progress')
       ORDER BY created_at DESC LIMIT 1`,
      [clanName]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (err) {
    console.error('Error getting clan battle:', err.message);
    return null;
  }
}

// Update clan battle status
async function updateClanBattleStatus(battleId, status, winnerClan = null) {
  if (!process.env.DATABASE_URL) return false;
  try {
    if (winnerClan) {
      await db.query(
        'UPDATE clan_battles SET status = $1, winner_clan = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [status, winnerClan, battleId]
      );
    } else {
      await db.query(
        'UPDATE clan_battles SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [status, battleId]
      );
    }
    return true;
  } catch (err) {
    console.error('Error updating clan battle:', err.message);
    return false;
  }
}

// Execute a clan battle round - returns battle results
async function executeClanBattleRound(battleId, clanAMembers, clanBMembers) {
  const results = [];
  const minSize = Math.min(clanAMembers.length, clanBMembers.length);
  
  // Shuffle for random matchups
  const shuffledA = [...clanAMembers].sort(() => Math.random() - 0.5);
  const shuffledB = [...clanBMembers].sort(() => Math.random() - 0.5);
  
  for (let i = 0; i < minSize; i++) {
    const fighterA = shuffledA[i];
    const fighterB = shuffledB[i];
    
    // Coin flip for attack type!
    const attackType = Math.random() < 0.5 ? 'distance' : 'melee';
    
    // Determine winner based on attack type
    let winner, loser;
    if (attackType === 'distance') {
      // Distance: higher number wins
      if (fighterA.player_number >= fighterB.player_number) {
        winner = fighterA;
        loser = fighterB;
      } else {
        winner = fighterB;
        loser = fighterA;
      }
    } else {
      // Melee: lower number wins
      if (fighterA.player_number <= fighterB.player_number) {
        winner = fighterA;
        loser = fighterB;
      } else {
        winner = fighterB;
        loser = fighterA;
      }
    }
    
    // Record round result
    if (process.env.DATABASE_URL) {
      try {
        await db.query(
          `INSERT INTO battle_rounds (battle_id, round_number, fighter1_id, fighter2_id, winner_id, fighter1_number, fighter2_number)
           VALUES ($1, (SELECT COALESCE(MAX(round_number), 0) + 1 FROM battle_rounds WHERE battle_id = $1), $2, $3, $4, $5, $6)`,
          [battleId, fighterA.od_identifier, fighterB.od_identifier, winner.od_identifier, fighterA.player_number, fighterB.player_number]
        );
      } catch (err) {
        console.error('Error recording battle round:', err.message);
      }
    }
    
    results.push({
      fighterA: { id: fighterA.od_identifier, name: fighterA.name, number: fighterA.player_number, characterImage: fighterA.character_image },
      fighterB: { id: fighterB.od_identifier, name: fighterB.name, number: fighterB.player_number, characterImage: fighterB.character_image },
      winner: { id: winner.od_identifier, name: winner.name },
      loser: { id: loser.od_identifier, name: loser.name },
      attackType: attackType
    });
  }
  
  // Return unbattled fighters
  const unbattledA = shuffledA.slice(minSize);
  const unbattledB = shuffledB.slice(minSize);
  
  return { results, unbattledA, unbattledB };
}

// Process battle results - update points and handle captures
async function processBattleResults(results, winnerClanName, winnerClanCreatorId) {
  const captures = [];
  
  for (const result of results) {
    // Winner gains 1 point
    if (process.env.DATABASE_URL) {
      await db.query('UPDATE players SET points = points + 1, updated_at = CURRENT_TIMESTAMP WHERE od_identifier = $1', [result.winner.id]);
    }
    
    // Loser loses 1 point
    if (process.env.DATABASE_URL) {
      const loserResult = await db.query(
        'UPDATE players SET points = points - 1, updated_at = CURRENT_TIMESTAMP WHERE od_identifier = $1 RETURNING points',
        [result.loser.id]
      );
      
      // Check if captured (points <= 0)
      if (loserResult.rows.length > 0 && loserResult.rows[0].points <= 0) {
        // Capture the character!
        await captureCharacter(result.loser.id, winnerClanName, winnerClanCreatorId);
        captures.push({
          capturedId: result.loser.id,
          capturedName: result.loser.name,
          newClan: winnerClanName,
          newOwner: winnerClanCreatorId
        });
      }
    }
  }
  
  return captures;
}

// Update clan name
async function updateClanName(odIdentifier, clanName) {
  if (!process.env.DATABASE_URL) return null;
  try {
    const name = clanName && clanName.trim() ? clanName.trim().substring(0, 30) : null;
    await db.query('UPDATE players SET clan_name = $1, updated_at = CURRENT_TIMESTAMP WHERE od_identifier = $2', [name, odIdentifier]);
    return name;
  } catch (err) {
    console.error('Error updating clan name:', err.message);
    return null;
  }
}

// Update player points in database
async function updatePlayerPoints(odIdentifier, points) {
  if (!process.env.DATABASE_URL) return;
  try {
    await db.query('UPDATE players SET points = $1, updated_at = CURRENT_TIMESTAMP WHERE od_identifier = $2', [points, odIdentifier]);
  } catch (err) {
    console.error('Database error updating points:', err.message);
  }
}

// Update daily challenge progress
async function updateDailyChallenge(odIdentifier, revengeKills, maxStreak) {
  if (!process.env.DATABASE_URL) return;
  try {
    await db.query(`UPDATE players SET 
      daily_revenge_kills = GREATEST(daily_revenge_kills, $1),
      daily_max_streak = GREATEST(daily_max_streak, $2),
      updated_at = CURRENT_TIMESTAMP 
      WHERE od_identifier = $3`, [revengeKills, maxStreak, odIdentifier]);
  } catch (err) {
    console.error('Database error updating daily challenge:', err.message);
  }
}

// Claim daily challenge reward
async function claimChallengeReward(odIdentifier, challengeType) {
  if (!process.env.DATABASE_URL) return false;
  try {
    const column = challengeType === 'revenge' ? 'challenge_revenge_claimed' : 'challenge_streak_claimed';
    const bonus = challengeType === 'revenge' ? 5 : 3;
    
    const result = await db.query(`UPDATE players SET 
      ${column} = TRUE,
      points = points + $1,
      updated_at = CURRENT_TIMESTAMP 
      WHERE od_identifier = $2 AND ${column} = FALSE
      RETURNING points`, [bonus, odIdentifier]);
    
    return result.rows.length > 0 ? result.rows[0].points : null;
  } catch (err) {
    console.error('Database error claiming challenge:', err.message);
    return null;
  }
}

// Get clan members
async function getClanMembers(clanName) {
  if (!process.env.DATABASE_URL || !clanName) return [];
  try {
    const result = await db.query('SELECT od_identifier, name, points, character_image, player_number FROM players WHERE clan_name = $1 ORDER BY points DESC', [clanName]);
    return result.rows.map(p => ({
      od_identifier: p.od_identifier, // Keep raw format for battle logic
      odIdentifier: p.od_identifier,
      name: p.name,
      points: p.points,
      characterImage: p.character_image,
      character_image: p.character_image, // Keep raw format for battle logic
      player_number: p.player_number
    }));
  } catch (err) {
    console.error('Database error getting clan members:', err.message);
    return [];
  }
}

// Get all clans with member counts
async function getAvailableClans() {
  if (!process.env.DATABASE_URL) return [];
  try {
    const result = await db.query(`
      SELECT clan_name as name, COUNT(*) as member_count 
      FROM players 
      WHERE clan_name IS NOT NULL 
      GROUP BY clan_name 
      ORDER BY member_count DESC
    `);
    return result.rows.map(c => ({
      name: c.name,
      memberCount: parseInt(c.member_count)
    }));
  } catch (err) {
    console.error('Database error getting clans:', err.message);
    return [];
  }
}

// Get characters controllable by a player in their clan
async function getMyClanCharacters(playerOdIdentifier, clanName) {
  if (!process.env.DATABASE_URL || !clanName) return [];
  try {
    // Get characters that are either:
    // 1. The player themselves
    // 2. Owned by the player (captured/recruited)
    // 3. In their clan with no specific owner (can be controlled by clan members)
    const result = await db.query(`
      SELECT od_identifier, name, points, character_image, player_number, owner_id
      FROM players 
      WHERE clan_name = $1 
      AND (od_identifier = $2 OR owner_id = $2 OR owner_id IS NULL)
      ORDER BY points DESC
    `, [clanName, playerOdIdentifier]);
    return result.rows;
  } catch (err) {
    console.error('Database error getting clan characters:', err.message);
    return [];
  }
}

// Get a specific player's data for switching
async function getPlayerForSwitch(odIdentifier) {
  if (!process.env.DATABASE_URL) return null;
  try {
    const result = await db.query('SELECT * FROM players WHERE od_identifier = $1', [odIdentifier]);
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (err) {
    console.error('Database error getting player:', err.message);
    return null;
  }
}

// Join a clan
async function joinClan(odIdentifier, clanName) {
  if (!process.env.DATABASE_URL) return false;
  try {
    await db.query('UPDATE players SET clan_name = $1, updated_at = CURRENT_TIMESTAMP WHERE od_identifier = $2', [clanName, odIdentifier]);
    return true;
  } catch (err) {
    console.error('Database error joining clan:', err.message);
    return false;
  }
}

// Recruit a player with 0 points into your clan
async function recruitPlayer(targetOdIdentifier, clanName, recruiterId) {
  if (!process.env.DATABASE_URL) return { success: false, error: 'No database' };
  try {
    // Check target has 0 points and no clan
    const targetResult = await db.query(
      'SELECT points, clan_name, name FROM players WHERE od_identifier = $1',
      [targetOdIdentifier]
    );
    
    if (targetResult.rows.length === 0) {
      return { success: false, error: 'Player not found' };
    }
    
    const target = targetResult.rows[0];
    
    if (target.points > 0) {
      return { success: false, error: 'Can only recruit players with 0 points' };
    }
    
    if (target.clan_name) {
      return { success: false, error: 'Player is already in a clan' };
    }
    
    // Recruit them - they join the clan and are owned by the recruiter
    await db.query(
      'UPDATE players SET clan_name = $1, owner_id = $2, updated_at = CURRENT_TIMESTAMP WHERE od_identifier = $3',
      [clanName, recruiterId, targetOdIdentifier]
    );
    
    return { success: true, name: target.name };
  } catch (err) {
    console.error('Database error recruiting player:', err.message);
    return { success: false, error: 'Database error' };
  }
}

// Update player name in database
async function updatePlayerName(odIdentifier, name) {
  if (!process.env.DATABASE_URL) return;
  try {
    await db.query('UPDATE players SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE od_identifier = $2', [name, odIdentifier]);
  } catch (err) {
    console.error('Database error updating name:', err.message);
  }
}

// Get all-time leaderboard from database
async function getAllTimeLeaderboard() {
  if (!process.env.DATABASE_URL) return [];
  try {
    const onlineIds = new Set(Array.from(players.values()).map(p => p.odIdentifier));
    const result = await db.query('SELECT od_identifier, name, points, character_image, clan_name FROM players ORDER BY points DESC LIMIT 100');
    
    return result.rows.map(p => ({
      odIdentifier: p.od_identifier,
      name: p.name,
      points: p.points,
      characterImage: p.character_image || 1,
      clanName: p.clan_name,
      online: onlineIds.has(p.od_identifier)
    }));
  } catch (err) {
    console.error('Database error getting leaderboard:', err.message);
    return [];
  }
}

// Get online players sorted by points (hide player_number)
function getLeaderboard() {
  return Array.from(players.values())
    .sort((a, b) => b.points - a.points)
    .map(p => ({ 
      id: p.id, 
      odIdentifier: p.odIdentifier, 
      name: p.name, 
      points: p.points, 
      streak: p.streak || 0,
      inPit: p.inPit, 
      characterImage: p.characterImage,
      clanName: p.clanName
    }));
}

// Get players in the pit (hide player_number)
function getPitPlayers(requestingPlayerId) {
  const now = Date.now();
  const requestingPlayer = players.get(requestingPlayerId);
  const myOdIdentifier = requestingPlayer ? requestingPlayer.odIdentifier : null;
  
  // Get my revenge targets
  const myRevengeTarget = revengeTargets.get(myOdIdentifier);
  const isMyRevenge = myRevengeTarget && myRevengeTarget.expiresAt > now ? myRevengeTarget.odIdentifier : null;
  
  return Array.from(players.values())
    .filter(p => p.inPit)
    .map(p => ({ 
      id: p.id, 
      odIdentifier: p.odIdentifier,
      name: p.name, 
      points: p.points,
      streak: p.streak || 0,
      characterImage: p.characterImage,
      action: p.action ? (p.action === 'defend' ? 'defending' : 'attacking') : 'idle',
      isRevenge: p.odIdentifier === isMyRevenge
    }));
}

// Broadcast game state to all players
async function broadcastState() {
  const allTime = await getAllTimeLeaderboard();
  const leaderboard = getLeaderboard();
  
  // Send personalized pit info to each player
  for (const [socketId, player] of players) {
    io.to(socketId).emit('gameState', {
      leaderboard: leaderboard,
      pit: getPitPlayers(socketId),
      allTimeLeaderboard: allTime,
      heckles: heckles
    });
  }
}

// Determine winner based on attack types and player numbers
function determineWinner(attacker, target) {
  const attackType = attacker.attackType; // 'distance' or 'melee'
  const targetAction = target.action;
  const targetAttackType = target.attackType;

  let result = {
    attacker: { id: attacker.id, name: attacker.name },
    defender: { id: target.id, name: target.name },
    winner: null,
    loser: null,
    reason: '',
    attackerNumber: attacker.playerNumber,
    defenderNumber: target.playerNumber,
    attackType: attackType
  };

  // Target is attacking someone else - attacker auto-wins
  if (targetAction === 'attack' && target.actionTarget !== attacker.id) {
    result.winner = attacker;
    result.loser = target;
    result.reason = 'caught attacking';
    return result;
  }

  // Mutual attack - both attacking each other
  if (targetAction === 'attack' && target.actionTarget === attacker.id) {
    // Distance vs Melee - Distance wins
    if (attackType === 'distance' && targetAttackType === 'melee') {
      result.winner = attacker;
      result.loser = target;
      result.reason = 'distance beats melee';
      return result;
    }
    if (attackType === 'melee' && targetAttackType === 'distance') {
      result.winner = target;
      result.loser = attacker;
      result.reason = 'distance beats melee';
      result.attackType = targetAttackType;
      return result;
    }
    // Same attack type - first click wins
    if (attacker.actionTime < target.actionTime) {
      result.winner = attacker;
      result.loser = target;
      result.reason = 'faster draw';
    } else {
      result.winner = target;
      result.loser = attacker;
      result.reason = 'faster draw';
    }
    return result;
  }

  // Target is defending or idle - compare numbers based on attack type
  if (attackType === 'distance') {
    // Higher number wins
    if (attacker.playerNumber >= target.playerNumber) {
      result.winner = attacker;
      result.loser = target;
      result.reason = attacker.playerNumber === target.playerNumber ? 'tie - attacker wins' : 'higher number';
    } else {
      result.winner = target;
      result.loser = attacker;
      result.reason = 'higher number';
    }
  } else {
    // Melee - lower number wins
    if (attacker.playerNumber <= target.playerNumber) {
      result.winner = attacker;
      result.loser = target;
      result.reason = attacker.playerNumber === target.playerNumber ? 'tie - attacker wins' : 'lower number';
    } else {
      result.winner = target;
      result.loser = attacker;
      result.reason = 'lower number';
    }
  }

  return result;
}

// Handle attacks
async function processAllAttacks() {
  const attacksByTarget = new Map();
  const now = Date.now();
  
  for (const player of players.values()) {
    if (player.inPit && player.action === 'attack' && player.actionTarget) {
      const targetId = player.actionTarget;
      if (!attacksByTarget.has(targetId)) {
        attacksByTarget.set(targetId, []);
      }
      attacksByTarget.get(targetId).push(player);
    }
  }

  const results = [];
  const losers = new Set();
  const winners = new Set();
  const winnerBonuses = new Map(); // Track bonus wins for revenge

  for (const [targetId, attackers] of attacksByTarget) {
    const target = players.get(targetId);
    if (!target || !target.inPit) continue;

    // Multiple attackers - target auto-loses
    if (attackers.length > 1) {
      losers.add(targetId);
      for (const attacker of attackers) {
        winners.add(attacker.id);
        
        // Check for revenge bonus
        const myRevenge = revengeTargets.get(attacker.odIdentifier);
        const isRevenge = myRevenge && myRevenge.odIdentifier === target.odIdentifier && myRevenge.expiresAt > now;
        if (isRevenge) {
          winnerBonuses.set(attacker.id, (winnerBonuses.get(attacker.id) || 0) + 2);
          revengeTargets.delete(attacker.odIdentifier); // Clear revenge after claiming
        }
        
        results.push({
          attacker: { id: attacker.id, name: attacker.name },
          defender: { id: target.id, name: target.name },
          winner: attacker,
          loser: target,
          reason: 'gang attack',
          attackType: attacker.attackType,
          attackerNumber: attacker.playerNumber,
          defenderNumber: target.playerNumber,
          isRevenge: isRevenge
        });
      }
    } else {
      const attacker = attackers[0];
      if (losers.has(attacker.id)) continue;
      
      const result = determineWinner(attacker, target);
      if (result) {
        // Check for revenge bonus
        if (result.winner && result.winner.id === attacker.id) {
          const myRevenge = revengeTargets.get(attacker.odIdentifier);
          const isRevenge = myRevenge && myRevenge.odIdentifier === target.odIdentifier && myRevenge.expiresAt > now;
          result.isRevenge = isRevenge;
          if (isRevenge) {
            winnerBonuses.set(attacker.id, (winnerBonuses.get(attacker.id) || 0) + 2);
            revengeTargets.delete(attacker.odIdentifier);
          }
        }
        
        results.push(result);
        if (result.loser) losers.add(result.loser.id);
        if (result.winner) winners.add(result.winner.id);
      }
    }
  }

  // Apply results
  for (const loserId of losers) {
    const loser = players.get(loserId);
    if (loser) {
      // Set revenge target for the loser
      const winner = results.find(r => r.loser && r.loser.id === loserId)?.winner;
      const winnerPlayer = winner ? players.get(winner.id) : null;
      
      if (winnerPlayer) {
        revengeTargets.set(loser.odIdentifier, {
          odIdentifier: winnerPlayer.odIdentifier,
          expiresAt: now + (3 * 60 * 1000) // 3 minutes
        });
      }
      
      // Subtract 1 point from loser (minimum 0)
      loser.points = Math.max(0, loser.points - 1);
      await updatePlayerPoints(loser.odIdentifier, loser.points);
      
      // CAPTURE: If loser hits 0 points, winner takes control!
      if (loser.points === 0 && winnerPlayer) {
        await captureCharacter(loser.odIdentifier, winnerPlayer.clanName, winnerPlayer.odIdentifier);
        loser.clanName = winnerPlayer.clanName;
        
        // Mark capture in results
        const resultEntry = results.find(r => r.loser && r.loser.id === loserId);
        if (resultEntry) {
          resultEntry.captured = true;
          resultEntry.capturedBy = winnerPlayer.name;
        }
      }
      
      loser.streak = 0; // Reset streak on loss
      loser.inPit = false;
      loser.action = null;
      loser.actionTarget = null;
      loser.actionTime = null;
      loser.attackType = null;
    }
  }

  for (const winnerId of winners) {
    const winner = players.get(winnerId);
    if (winner && !losers.has(winnerId)) {
      const bonus = winnerBonuses.get(winnerId) || 0;
      const isRevengeKill = bonus > 0;
      
      winner.points += 1 + bonus;
      winner.streak = (winner.streak || 0) + 1;
      
      // Track daily challenges
      if (isRevengeKill) {
        winner.dailyRevengeKills = (winner.dailyRevengeKills || 0) + 1;
      }
      if (winner.streak > (winner.dailyMaxStreak || 0)) {
        winner.dailyMaxStreak = winner.streak;
      }
      await updateDailyChallenge(winner.odIdentifier, winner.dailyRevengeKills || 0, winner.dailyMaxStreak || 0);
      
      winner.action = null;
      winner.actionTarget = null;
      winner.actionTime = null;
      winner.attackType = null;
      winner.canHeckle = true; // Winner can now heckle
      await updatePlayerPoints(winner.odIdentifier, winner.points);
      
      // Add extra info to results for sound effects
      const resultEntry = results.find(r => r.winner && r.winner.id === winnerId);
      if (resultEntry) {
        resultEntry.isStreakKill = winner.streak >= 5;
        resultEntry.isGangAttack = resultEntry.reason === 'gang attack';
      }
    }
  }

  return results;
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('identify', async (data) => {
    const playerId = data.playerId;
    const requestedName = data.name;
    
    const persistent = await getOrCreatePlayer(playerId, requestedName);
    
    // If new player, ask them to select character
    if (persistent.isNew) {
      socket.emit('selectCharacter', {
        odIdentifier: persistent.odIdentifier,
        name: persistent.name
      });
      return;
    }
    
    const playerData = {
      id: socket.id,
      odIdentifier: persistent.odIdentifier,
      name: persistent.name,
      points: persistent.points,
      playerNumber: persistent.playerNumber,
      characterImage: persistent.characterImage,
      clanName: persistent.clanName,
      dailyRevengeKills: persistent.dailyRevengeKills,
      dailyMaxStreak: persistent.dailyMaxStreak,
      challengeRevengeClaimed: persistent.challengeRevengeClaimed,
      challengeStreakClaimed: persistent.challengeStreakClaimed,
      streak: 0,
      inPit: false,
      action: null,
      actionTarget: null,
      actionTime: null,
      attackType: null,
      canHeckle: false
    };
    players.set(socket.id, playerData);

    const allTime = await getAllTimeLeaderboard();
    
    // Don't send playerNumber to client
    socket.emit('welcome', { 
      you: { 
        id: playerData.id, 
        odIdentifier: playerData.odIdentifier, 
        name: playerData.name, 
        points: playerData.points,
        characterImage: playerData.characterImage,
        clanName: playerData.clanName,
        streak: playerData.streak,
        canHeckle: playerData.canHeckle,
        dailyRevengeKills: playerData.dailyRevengeKills,
        dailyMaxStreak: playerData.dailyMaxStreak,
        challengeRevengeClaimed: playerData.challengeRevengeClaimed,
        challengeStreakClaimed: playerData.challengeStreakClaimed
      },
      leaderboard: getLeaderboard(),
      pit: getPitPlayers(socket.id),
      allTimeLeaderboard: allTime,
      heckles: heckles
    });

    broadcastState();
  });

  socket.on('confirmCharacter', async (data) => {
    const { odIdentifier, name, characterImage } = data;
    
    const persistent = await createNewPlayer(odIdentifier, name, characterImage);
    
    const playerData = {
      id: socket.id,
      odIdentifier: persistent.odIdentifier,
      name: persistent.name,
      points: persistent.points,
      playerNumber: persistent.playerNumber,
      characterImage: persistent.characterImage,
      clanName: persistent.clanName,
      dailyRevengeKills: 0,
      dailyMaxStreak: 0,
      challengeRevengeClaimed: false,
      challengeStreakClaimed: false,
      streak: 0,
      inPit: false,
      action: null,
      actionTarget: null,
      actionTime: null,
      attackType: null,
      canHeckle: false
    };
    players.set(socket.id, playerData);

    const allTime = await getAllTimeLeaderboard();
    
    socket.emit('welcome', { 
      you: { 
        id: playerData.id, 
        odIdentifier: playerData.odIdentifier, 
        name: playerData.name, 
        points: playerData.points,
        characterImage: playerData.characterImage,
        clanName: playerData.clanName,
        streak: playerData.streak,
        canHeckle: playerData.canHeckle,
        dailyRevengeKills: 0,
        dailyMaxStreak: 0,
        challengeRevengeClaimed: false,
        challengeStreakClaimed: false
      },
      leaderboard: getLeaderboard(),
      pit: getPitPlayers(socket.id),
      allTimeLeaderboard: allTime,
      heckles: heckles
    });

    broadcastState();
  });

  socket.on('createClan', async (clanName) => {
    const p = players.get(socket.id);
    if (!p) return;
    
    if (p.points < 10) {
      socket.emit('error', { message: 'You need 10 points to create a clan!' });
      return;
    }
    
    if (p.clanName) {
      socket.emit('error', { message: 'You are already in a clan!' });
      return;
    }
    
    const newClanName = await createClan(p.odIdentifier, clanName);
    if (newClanName) {
      p.clanName = newClanName;
      socket.emit('clanCreated', { clanName: newClanName });
      broadcastState();
    }
  });

  socket.on('getClanMembers', async (clanName) => {
    const members = await getClanMembers(clanName);
    socket.emit('clanMembers', { clanName, members });
  });

  socket.on('joinClan', async (clanName) => {
    const p = players.get(socket.id);
    if (!p) return;
    
    if (p.clanName) {
      socket.emit('error', { message: 'You are already in a clan! Leave your current clan first.' });
      return;
    }
    
    const success = await joinClan(p.odIdentifier, clanName);
    if (success) {
      p.clanName = clanName;
      socket.emit('clanJoined', { clanName });
      broadcastState();
    }
  });

  socket.on('leaveClan', async () => {
    const p = players.get(socket.id);
    if (!p || !p.clanName) return;
    
    await joinClan(p.odIdentifier, null); // Set clan to null
    p.clanName = null;
    socket.emit('clanLeft');
    broadcastState();
  });

  socket.on('claimChallenge', async (challengeType) => {
    const p = players.get(socket.id);
    if (!p) return;
    
    if (challengeType === 'revenge' && p.dailyRevengeKills >= 3 && !p.challengeRevengeClaimed) {
      const newPoints = await claimChallengeReward(p.odIdentifier, 'revenge');
      if (newPoints !== null) {
        p.points = newPoints;
        p.challengeRevengeClaimed = true;
        socket.emit('challengeClaimed', { type: 'revenge', bonus: 5, newPoints });
        broadcastState();
      }
    } else if (challengeType === 'streak' && p.dailyMaxStreak >= 5 && !p.challengeStreakClaimed) {
      const newPoints = await claimChallengeReward(p.odIdentifier, 'streak');
      if (newPoints !== null) {
        p.points = newPoints;
        p.challengeStreakClaimed = true;
        socket.emit('challengeClaimed', { type: 'streak', bonus: 3, newPoints });
        broadcastState();
      }
    } else {
      socket.emit('error', { message: 'Challenge not completed or already claimed!' });
    }
  });

  // Clan Battle Handlers
  socket.on('challengeClan', async (defenderClanName) => {
    const p = players.get(socket.id);
    if (!p || !p.clanName) {
      socket.emit('error', { message: 'You must be in a clan to challenge!' });
      return;
    }
    
    if (p.clanName === defenderClanName) {
      socket.emit('error', { message: 'You cannot challenge your own clan!' });
      return;
    }
    
    // Check defender clan exists and has members
    const defenderMembers = await getClanMembers(defenderClanName);
    if (defenderMembers.length === 0) {
      socket.emit('error', { message: 'That clan does not exist!' });
      return;
    }
    
    // Check for existing battle
    const existingBattle = await getActiveClanBattle(p.clanName);
    if (existingBattle) {
      socket.emit('error', { message: 'Your clan already has an active battle!' });
      return;
    }
    
    // Create battle
    const battleId = await createClanBattle(p.clanName, defenderClanName);
    if (battleId) {
      // Notify all players about the challenge
      io.emit('clanBattleChallenge', {
        battleId,
        challengerClan: p.clanName,
        defenderClan: defenderClanName
      });
      socket.emit('battleCreated', { battleId, defenderClan: defenderClanName });
    }
  });

  socket.on('acceptClanBattle', async (battleId) => {
    const p = players.get(socket.id);
    if (!p || !p.clanName) return;
    
    const battle = await getActiveClanBattle(p.clanName);
    if (!battle || battle.id !== battleId || battle.defender_clan !== p.clanName) {
      socket.emit('error', { message: 'Invalid battle!' });
      return;
    }
    
    // Get member counts
    const challengerMembers = await getClanMembers(battle.challenger_clan);
    const defenderMembers = await getClanMembers(battle.defender_clan);
    
    await updateClanBattleStatus(battleId, 'accepted');
    io.emit('clanBattleAccepted', { 
      battleId, 
      challengerClan: battle.challenger_clan, 
      defenderClan: battle.defender_clan,
      challengerCount: challengerMembers.length,
      defenderCount: defenderMembers.length
    });
  });

  socket.on('declineClanBattle', async (battleId) => {
    const p = players.get(socket.id);
    if (!p || !p.clanName) return;
    
    const battle = await getActiveClanBattle(p.clanName);
    if (!battle || battle.id !== battleId || battle.defender_clan !== p.clanName) return;
    
    await updateClanBattleStatus(battleId, 'declined');
    io.emit('clanBattleDeclined', { battleId });
  });

  socket.on('startClanBattle', async (battleId) => {
    const p = players.get(socket.id);
    if (!p || !p.clanName) return;
    
    const battle = await getActiveClanBattle(p.clanName);
    if (!battle || battle.id !== battleId || battle.status !== 'accepted') {
      socket.emit('error', { message: 'Battle not ready!' });
      return;
    }
    
    // Get both clans' members - SNAPSHOT at start of battle
    const clanAMembers = await getClanMembers(battle.challenger_clan);
    const clanBMembers = await getClanMembers(battle.defender_clan);
    
    const clanACreator = await getClanCreator(battle.challenger_clan);
    const clanBCreator = await getClanCreator(battle.defender_clan);
    
    await updateClanBattleStatus(battleId, 'in_progress');
    
    // Track all point changes to apply at end
    const pointChanges = {}; // odIdentifier -> change
    const pendingCaptures = []; // Characters to capture at end
    
    // Best of 3 rounds
    let clanAWins = 0;
    let clanBWins = 0;
    const maxRounds = 3;
    
    for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
      // Check if battle is already decided
      if (clanAWins >= 2 || clanBWins >= 2) break;
      
      // Execute round - each character battles once
      const { results } = await executeClanBattleRound(battleId, clanAMembers, clanBMembers);
      
      // Count wins this round
      let roundAWins = 0;
      let roundBWins = 0;
      
      for (const result of results) {
        const winnerFromClanA = clanAMembers.find(m => m.od_identifier === result.winner.id);
        
        if (winnerFromClanA) {
          roundAWins++;
        } else {
          roundBWins++;
        }
        
        // Track point changes
        pointChanges[result.winner.id] = (pointChanges[result.winner.id] || 0) + 1;
        pointChanges[result.loser.id] = (pointChanges[result.loser.id] || 0) - 1;
      }
      
      // Determine round winner
      if (roundAWins > roundBWins) {
        clanAWins++;
      } else if (roundBWins > roundAWins) {
        clanBWins++;
      }
      // Tie = no one gets a round win
      
      // Emit round results with round winner info
      io.emit('clanBattleRound', {
        battleId,
        round: roundNum,
        results,
        roundWinner: roundAWins > roundBWins ? battle.challenger_clan : 
                     roundBWins > roundAWins ? battle.defender_clan : 'TIE',
        roundScore: { 
          [battle.challenger_clan]: roundAWins, 
          [battle.defender_clan]: roundBWins 
        },
        overallScore: {
          [battle.challenger_clan]: clanAWins,
          [battle.defender_clan]: clanBWins
        }
      });
      
      // Delay between rounds for animation
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Determine overall winner
    const winnerClan = clanAWins >= clanBWins ? battle.challenger_clan : battle.defender_clan;
    const winnerCreator = clanAWins >= clanBWins ? clanACreator : clanBCreator;
    const loserClan = winnerClan === battle.challenger_clan ? battle.defender_clan : battle.challenger_clan;
    
    // Apply all point changes now
    for (const [odId, change] of Object.entries(pointChanges)) {
      if (process.env.DATABASE_URL) {
        const result = await db.query(
          'UPDATE players SET points = GREATEST(0, points + $1) WHERE od_identifier = $2 RETURNING points, name, clan_name',
          [change, odId]
        );
        
        // Check for captures (hit 0 points AND on losing team)
        if (result.rows.length > 0 && result.rows[0].points <= 0 && result.rows[0].clan_name === loserClan) {
          pendingCaptures.push({
            capturedId: odId,
            capturedName: result.rows[0].name,
            fromClan: loserClan,
            newClan: winnerClan
          });
        }
      }
    }
    
    // Execute captures
    for (const capture of pendingCaptures) {
      await captureCharacter(capture.capturedId, winnerClan, winnerCreator);
    }
    
    await updateClanBattleStatus(battleId, 'completed', winnerClan);
    
    io.emit('clanBattleComplete', {
      battleId,
      winnerClan,
      finalScore: {
        [battle.challenger_clan]: clanAWins,
        [battle.defender_clan]: clanBWins
      },
      totalCaptures: pendingCaptures
    });
    
    broadcastState();
  });

  socket.on('getOwnedCharacters', async () => {
    const p = players.get(socket.id);
    if (!p) return;
    
    const characters = await getOwnedCharacters(p.odIdentifier);
    socket.emit('ownedCharacters', { characters });
  });

  socket.on('recruitPlayer', async (targetOdIdentifier) => {
    const p = players.get(socket.id);
    if (!p) return;
    
    if (!p.clanName) {
      socket.emit('error', { message: 'You must be in a clan to recruit!' });
      return;
    }
    
    const result = await recruitPlayer(targetOdIdentifier, p.clanName, p.odIdentifier);
    
    if (result.success) {
      socket.emit('playerRecruited', { 
        name: result.name, 
        clanName: p.clanName 
      });
      
      // Notify the recruited player if they're online
      for (const [socketId, player] of players.entries()) {
        if (player.odIdentifier === targetOdIdentifier) {
          player.clanName = p.clanName;
          io.to(socketId).emit('youWereRecruited', { 
            clanName: p.clanName,
            recruiterName: p.name 
          });
          break;
        }
      }
      
      broadcastState();
    } else {
      socket.emit('error', { message: result.error });
    }
  });

  // Get available clans for clan wars menu
  socket.on('getAvailableClans', async () => {
    const clans = await getAvailableClans();
    socket.emit('availableClans', { clans });
  });

  // Get characters in my clan that I can switch to
  socket.on('getMyClanCharacters', async () => {
    const p = players.get(socket.id);
    if (!p || !p.clanName) {
      socket.emit('myClanCharacters', { characters: [] });
      return;
    }
    
    const characters = await getMyClanCharacters(p.odIdentifier, p.clanName);
    socket.emit('myClanCharacters', { characters });
  });

  // Switch to a different character in my clan
  socket.on('switchCharacter', async (targetOdIdentifier) => {
    const p = players.get(socket.id);
    if (!p || !p.clanName) {
      socket.emit('error', { message: 'You must be in a clan to switch characters!' });
      return;
    }
    
    if (p.inPit) {
      socket.emit('error', { message: 'Cannot switch while in the pit!' });
      return;
    }
    
    // Verify the target character is in the same clan and controllable
    const targetData = await getPlayerForSwitch(targetOdIdentifier);
    if (!targetData || targetData.clan_name !== p.clanName) {
      socket.emit('error', { message: 'Cannot switch to that character!' });
      return;
    }
    
    // Check if target is owned by this player or has no owner
    if (targetData.owner_id && targetData.owner_id !== p.odIdentifier) {
      socket.emit('error', { message: 'You do not control that character!' });
      return;
    }
    
    // Update the player's current character
    p.odIdentifier = targetData.od_identifier;
    p.name = targetData.name;
    p.points = targetData.points;
    p.playerNumber = targetData.player_number;
    p.characterImage = targetData.character_image || 1;
    
    socket.emit('characterSwitched', {
      odIdentifier: p.odIdentifier,
      name: p.name,
      points: p.points,
      characterImage: p.characterImage
    });
    
    broadcastState();
  });

  socket.on('changeClanName', async (newClanName) => {
    const p = players.get(socket.id);
    if (!p || !p.clanName) return;
    
    const updatedName = await updateClanName(p.odIdentifier, newClanName);
    p.clanName = updatedName;
    socket.emit('clanNameChanged', { clanName: updatedName });
    broadcastState();
  });

  socket.on('joinPit', () => {
    const p = players.get(socket.id);
    if (p && !p.inPit) {
      p.inPit = true;
      p.action = null;
      p.actionTarget = null;
      p.attackType = null;
      broadcastState();
      socket.emit('pitJoined');
    }
  });

  socket.on('leavePit', () => {
    const p = players.get(socket.id);
    if (p && p.inPit) {
      p.inPit = false;
      p.action = null;
      p.actionTarget = null;
      p.attackType = null;
      broadcastState();
      socket.emit('pitLeft');
    }
  });

  socket.on('defend', () => {
    const p = players.get(socket.id);
    if (p && p.inPit && !p.action) {
      p.action = 'defend';
      p.actionTime = Date.now();
      p.attackType = null;
      broadcastState();
      socket.emit('actionSet', { action: 'defend' });
    }
  });

  socket.on('attack', async (data) => {
    const targetId = data.targetId;
    const attackType = data.attackType; // 'distance' or 'melee'
    
    const p = players.get(socket.id);
    const target = players.get(targetId);
    
    if (!p || !p.inPit) {
      socket.emit('error', { message: 'You are not in the pit' });
      return;
    }
    if (!target || !target.inPit) {
      socket.emit('error', { message: 'Invalid target' });
      return;
    }
    if (targetId === socket.id) {
      socket.emit('error', { message: 'Cannot attack yourself' });
      return;
    }
    if (attackType !== 'distance' && attackType !== 'melee') {
      socket.emit('error', { message: 'Invalid attack type' });
      return;
    }

    p.action = 'attack';
    p.actionTarget = targetId;
    p.actionTime = Date.now();
    p.attackType = attackType;

    const results = await processAllAttacks();
    
    if (results.length > 0) {
      io.emit('battleResults', results);
    }
    
    broadcastState();
  });

  socket.on('changeName', async (newName) => {
    const p = players.get(socket.id);
    if (p && newName && newName.trim().length > 0 && newName.length <= 20) {
      p.name = newName.trim();
      await updatePlayerName(p.odIdentifier, p.name);
      socket.emit('nameChanged', { name: p.name });
      broadcastState();
    }
  });

  socket.on('heckle', (message) => {
    const p = players.get(socket.id);
    if (!p || !p.canHeckle) {
      socket.emit('error', { message: 'You must win a battle to heckle!' });
      return;
    }
    
    const cleanMessage = message.trim().substring(0, 100); // Limit to 100 chars
    if (!cleanMessage) return;
    
    // Add heckle
    heckles.unshift({
      name: p.name,
      message: cleanMessage,
      characterImage: p.characterImage,
      timestamp: Date.now()
    });
    
    // Keep only last 3
    while (heckles.length > 3) {
      heckles.pop();
    }
    
    // Remove heckle ability after use
    p.canHeckle = false;
    socket.emit('heckleUsed');
    
    broadcastState();
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    players.delete(socket.id);
    broadcastState();
  });
});

// Reset defend action after 10 seconds
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const player of players.values()) {
    if (player.action === 'defend' && player.actionTime && (now - player.actionTime > 10000)) {
      player.action = null;
      player.actionTime = null;
      changed = true;
    }
  }
  if (changed) broadcastState();
}, 5000);

// Start server
initDatabase().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Rumble Pit running on http://localhost:${PORT}`);
  });
});
