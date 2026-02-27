/**
 * LoveSpark Boxhead — Game Engine
 * Cute pastel zombie survival where YOU write the AI bot 🩷🧟‍♀️
 *
 * Architecture:
 *   - Fixed 60 fps game loop (requestAnimationFrame + accumulator)
 *   - Bot runs every BOT_INTERVAL frames; movement persists between calls
 *   - Circular arena border; walls stop movement
 *   - All coordinates in pixel space; TILE constant converts to grid
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const TILE   = 27;   // px per grid cell
const GRID   = 20;   // cells per row/col
const W      = TILE * GRID;  // canvas width  (540)
const H      = TILE * GRID;  // canvas height (540)
const WALL   = TILE;          // wall thickness (one tile)
const BOT_INTERVAL = 6;       // run bot every N frames (~10 fps decisions)
const FPS_TARGET   = 60;

const WEAPONS = {
    pistol:  { label:'Pistol 🔫',  damage:10, maxAmmo:12, cooldown:0.25, speed:380, spread:0,    pellets:1, color:'#c4b5fd' },
    shotgun: { label:'Shotgun 💥', damage:22, maxAmmo:6,  cooldown:0.6,  speed:300, spread:0.25, pellets:3, color:'#fda4af' },
    rifle:   { label:'Rifle 🎯',   damage:18, maxAmmo:20, cooldown:0.18, speed:550, spread:0,    pellets:1, color:'#86efac' },
};

const MOTIVATIONAL = [
    'You got this! 💕', 'Amazing! ✨', 'Keep going! 🌸',
    'Unstoppable! 💪', 'So good! 🩷', 'Nice shot! 🎯',
    'Incredible! 🌟', 'Boss vibes! 👑',
];

// ─── Seeded PRNG ────────────────────────────────────────────────────────────

function makeRng(seed) {
    let state = seed | 0 || 1;
    return function rng() {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 4294967296;
    };
}

function newSeed() {
    return (Math.random() * 4294967296) >>> 0;
}

// ─── Bot hash ───────────────────────────────────────────────────────────────

async function computeBotHash(code) {
    const trimmed = code.replace(/\s+/g, ' ').trim();
    try {
        const buf  = new TextEncoder().encode(trimmed);
        const hash = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
        let h = 0x811c9dc5;
        for (let i = 0; i < trimmed.length; i++) {
            h ^= trimmed.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16).padStart(8, '0');
    }
}

// ─── Episode event logger ───────────────────────────────────────────────────

function logEpisodeEvent(type, data) {
    s.episode.events.push({
        f: s.episodeFrame,
        t: Math.round(s.time * 1000) / 1000,
        type,
        ...data,
    });
}

const DEFAULT_CODE = `/**
 * 🩷 Your bot AI — edit me!
 * Return one of:
 *   "moveUp" | "moveDown" | "moveLeft" | "moveRight"
 *   "shoot"  | "pickup"   | "reload"   | "retreat"  | "explore"
 */
function myAgent(gameState) {
  const {
    myHealth, myPosition, myWeapon,
    ammo, nearbyZombies, nearbyWeapons,
    nearbyHealth, wave
  } = gameState;

  // Grab health packs if low and nearby
  if (myHealth < 40 && nearbyHealth.length > 0
      && nearbyHealth[0].distance < 4) {
    return "pickup";
  }

  // Pick up better weapons
  if (myWeapon === "none" && nearbyWeapons.length > 0) {
    return "pickup";
  }

  // Shoot nearest zombie if we have ammo
  if (nearbyZombies.length > 0 && ammo > 0) {
    return "shoot";
  }

  // Reload when empty
  if (ammo === 0) {
    return "reload";
  }

  // Run away if health is critical
  if (myHealth < 25 && nearbyZombies.length > 0) {
    return "retreat";
  }

  return "explore";
}`;

// ─── State ───────────────────────────────────────────────────────────────────

let s   = {};   // game state (reset in resetGame)
let ctx = null; // canvas 2d context

function resetGame() {
    s = {
        phase:   'idle',   // idle | playing | gameover
        wave:    0,
        score:   0,
        kills:   0,
        time:    0,        // seconds alive

        // Wave management
        waveZombies:  0,   // total to spawn this wave
        waveSpawned:  0,
        waveAlive:    0,
        spawnTimer:   0,
        spawnInterval:1.5,
        waveDelay:    0,   // countdown to next wave

        player: {
            x: W / 2, y: H / 2,
            health: 100, maxHealth: 100,
            weapon: 'pistol',
            ammo: 12, maxAmmo: 12,
            cooldown: 0,
            invincible: 0,  // seconds of iframes after hit
            facing: 0,      // radians, for drawing
        },

        zombies:   [],
        bullets:   [],
        items:     [],
        particles: [],
        messages:  [],  // floating text on canvas

        // Bot state
        botFn:        null,
        botError:     null,
        botMoveDir:   null, // persists between bot calls
        botFrame:     0,

        // Explore wander target
        exploreTarget: null,
        flashTimer: 0,  // screen damage flash

        // Seeded PRNG
        seed: 0,
        rng:  null,

        // Health respawn (game-tick timer, replaces setTimeout)
        healthRespawnTimer: -1,
        healthRespawnX: 0,
        healthRespawnY: 0,

        // Episode trace
        episode: {
            meta:   { seed: 0, botHash: '', startedAt: '' },
            frames: [],
            events: [],
        },
        episodeFrame: 0,
    };
    s.rng = makeRng(1); // placeholder, overwritten by startGame
}

// ─── Item placement ──────────────────────────────────────────────────────────

function spawnStartItems() {
    const placements = [
        { gx:3,  gy:3,  type:'pistol'  },
        { gx:16, gy:3,  type:'shotgun' },
        { gx:3,  gy:16, type:'rifle'   },
        { gx:16, gy:16, type:'pistol'  },
        { gx:10, gy:2,  type:'health'  },
        { gx:10, gy:17, type:'health'  },
        { gx:2,  gy:10, type:'health'  },
        { gx:17, gy:10, type:'health'  },
    ];
    for (const p of placements) {
        s.items.push({ x: p.gx * TILE + TILE/2, y: p.gy * TILE + TILE/2, type: p.type, pulse: s.rng()*Math.PI*2 });
    }
}

// ─── Wave system ─────────────────────────────────────────────────────────────

function startNextWave() {
    s.wave++;
    s.waveZombies   = 4 + s.wave * 3;
    s.waveSpawned   = 0;
    s.waveAlive     = 0;
    s.spawnInterval = Math.max(0.4, 1.5 - s.wave * 0.08);
    s.spawnTimer    = 0;
    s.waveDelay     = -1; // no longer in delay
    logEpisodeEvent('wave_start', { wave: s.wave });
    showMsg(`Wave ${s.wave}! 🌊`, W/2, 80, '#c026d3', 2.5);
    if (s.wave % 5 === 0) showMsg('👑 BOSS WAVE!', W/2, 110, '#dc2626', 2.5);
}

function maybeSpawnZombie(dt) {
    if (s.waveSpawned >= s.waveZombies) return;
    s.spawnTimer -= dt;
    if (s.spawnTimer > 0) return;
    s.spawnTimer = s.spawnInterval;
    spawnZombie();
}

function spawnZombie() {
    // Spawn along the inner edge of the wall
    const side = Math.floor(s.rng() * 4);
    const pad  = WALL + 8;
    let x, y;
    if (side === 0) { x = pad + s.rng()*(W-pad*2); y = pad; }
    else if (side===1) { x = W-pad; y = pad + s.rng()*(H-pad*2); }
    else if (side===2) { x = pad + s.rng()*(W-pad*2); y = H-pad; }
    else              { x = pad;   y = pad + s.rng()*(H-pad*2); }

    const isBoss = s.wave % 5 === 0 && s.waveSpawned === 0;
    const isFast = !isBoss && s.rng() > 0.65;
    const hp     = (30 + s.wave * 5) * (isBoss ? 3 : 1);
    const spd    = (isBoss ? 45 : isFast ? 90 : 55) + s.wave * 3;

    s.zombies.push({
        x, y,
        health: hp, maxHealth: hp,
        speed:  spd,
        size:   isBoss ? 22 : (isFast ? 11 : 14),
        damage: isBoss ? 20 : 10,
        type:   isBoss ? 'boss' : isFast ? 'fast' : 'normal',
        color:  isBoss ? '#f472b6' : isFast ? '#86efac' : '#c4b5fd',
        wobble: s.rng()*Math.PI*2,
        hitFlash: 0,
    });
    s.waveSpawned++;
    s.waveAlive++;
}

// ─── Bot execution ────────────────────────────────────────────────────────────

/** Build the gameState object passed to the player's function */
function buildGameState() {
    const p  = s.player;
    const px = p.x / TILE;
    const py = p.y / TILE;

    const zombies = s.zombies
        .map(z => ({ x:z.x/TILE, y:z.y/TILE, health:z.health, distance:Math.hypot(z.x-p.x,z.y-p.y)/TILE }))
        .sort((a,b) => a.distance-b.distance)
        .slice(0,10);

    const weapons = s.items
        .filter(i => i.type !== 'health')
        .map(i => ({ x:i.x/TILE, y:i.y/TILE, type:i.type, distance:Math.hypot(i.x-p.x,i.y-p.y)/TILE }))
        .sort((a,b) => a.distance-b.distance);

    const health = s.items
        .filter(i => i.type === 'health')
        .map(i => ({ x:i.x/TILE, y:i.y/TILE, distance:Math.hypot(i.x-p.x,i.y-p.y)/TILE }))
        .sort((a,b) => a.distance-b.distance);

    return {
        myHealth: p.health,
        myPosition: { x: px, y: py },
        myWeapon: p.weapon,
        ammo: p.ammo,
        nearbyZombies: zombies,
        nearbyWeapons: weapons,
        nearbyHealth:  health,
        wave:   s.wave,
        score:  s.score,
        kills:  s.kills,
    };
}

function runBot() {
    if (!s.botFn) return;
    try {
        const t0  = performance.now();
        const act = s.botFn(buildGameState());
        const ms  = performance.now() - t0;
        if (ms > 50) s.botError = `Slow bot: ${ms.toFixed(0)}ms — avoid heavy loops`;
        if (typeof act === 'string') processAction(act);
        if (!s.botError) updateBotStatus('ok', '✅ Running');
    } catch(e) {
        s.botError = e.message;
        updateBotStatus('err', '❌ ' + e.message);
    }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

const MOVE_ACTIONS = new Set(['moveUp','moveDown','moveLeft','moveRight','retreat','explore']);
const INST_ACTIONS = new Set(['shoot','pickup','reload']);

function processAction(act) {
    if (MOVE_ACTIONS.has(act)) s.botMoveDir = act;
    if (INST_ACTIONS.has(act)) doInstant(act);
}

/** Applied every frame — smooth movement */
function applyMovement(dt) {
    if (!s.botMoveDir) return;
    const p  = s.player;
    const sp = 110 * dt; // pixels per frame
    let dx = 0, dy = 0;

    switch (s.botMoveDir) {
        case 'moveUp':    dy = -1; break;
        case 'moveDown':  dy =  1; break;
        case 'moveLeft':  dx = -1; break;
        case 'moveRight': dx =  1; break;
        case 'retreat': {
            const nz = nearestZombie();
            if (nz) { dx = p.x - nz.x; dy = p.y - nz.y; }
            break;
        }
        case 'explore': {
            const ni = [...s.items].sort((a,b)=>Math.hypot(a.x-p.x,a.y-p.y)-Math.hypot(b.x-p.x,b.y-p.y))[0];
            if (ni && Math.hypot(ni.x-p.x, ni.y-p.y) < W*0.55) {
                dx = ni.x - p.x; dy = ni.y - p.y;
            } else {
                if (!s.exploreTarget || Math.hypot(s.exploreTarget.x-p.x, s.exploreTarget.y-p.y)<24) {
                    s.exploreTarget = { x: WALL+s.rng()*(W-WALL*2), y: WALL+s.rng()*(H-WALL*2) };
                }
                dx = s.exploreTarget.x - p.x;
                dy = s.exploreTarget.y - p.y;
            }
            break;
        }
    }

    if (dx !== 0 || dy !== 0) {
        const len = Math.hypot(dx, dy);
        const nx = p.x + (dx/len)*sp;
        const ny = p.y + (dy/len)*sp;
        // Clamp inside arena walls
        const margin = WALL + 10;
        p.x = Math.max(margin, Math.min(W-margin, nx));
        p.y = Math.max(margin, Math.min(H-margin, ny));
        p.facing = Math.atan2(dy/len, dx/len);
    }
}

function doInstant(act) {
    switch (act) {
        case 'shoot':  doShoot();  break;
        case 'pickup': doPickup(); break;
        case 'reload': doReload(); break;
    }
}

function doShoot() {
    const p  = s.player;
    const wp = WEAPONS[p.weapon];
    if (!wp || p.ammo <= 0 || p.cooldown > 0) return;

    const nz = nearestZombie();
    if (!nz) return;

    const baseAngle = Math.atan2(nz.y - p.y, nz.x - p.x);
    p.facing = baseAngle;

    for (let i = 0; i < wp.pellets; i++) {
        const angle = baseAngle + (s.rng()-0.5)*wp.spread;
        s.bullets.push({
            x: p.x, y: p.y,
            vx: Math.cos(angle)*wp.speed,
            vy: Math.sin(angle)*wp.speed,
            damage: wp.damage,
            weapon: p.weapon,
            life: 1.2,
        });
    }
    p.ammo--;
    p.cooldown = wp.cooldown;

    // Muzzle flash particle
    spawnParticles(p.x + Math.cos(baseAngle)*14, p.y + Math.sin(baseAngle)*14, '#fbbf24', 4, 0.15);
}

function doPickup() {
    const p   = s.player;
    const idx = nearestItemIndex(60);
    if (idx < 0) return;
    const item = s.items[idx];

    if (item.type === 'health') {
        p.health = Math.min(p.maxHealth, p.health + 30);
        logEpisodeEvent('pickup_health', { amount: 30 });
        spawnParticles(item.x, item.y, '#ef4444', 10, 0.5);
        showMsg('+30 HP 💖', item.x, item.y - 20, '#ef4444', 1.2);
    } else {
        p.weapon = item.type;
        p.ammo   = WEAPONS[item.type].maxAmmo;
        p.maxAmmo= WEAPONS[item.type].maxAmmo;
        logEpisodeEvent('pickup_weapon', { weapon: item.type });
        spawnParticles(item.x, item.y, '#c084fc', 8, 0.4);
        showMsg(`Got ${WEAPONS[item.type].label}!`, item.x, item.y-20, '#c084fc', 1.2);
    }
    s.items.splice(idx, 1);
    // Respawn another health pack somewhere after pickup
    if (item.type === 'health' && s.rng() > 0.4) scheduleHealthRespawn();
}

function doReload() {
    const p  = s.player;
    p.ammo   = WEAPONS[p.weapon]?.maxAmmo ?? 0;
    p.maxAmmo= p.ammo;
    showMsg('Reloaded! 🔄', p.x, p.y - 30, '#86efac', 1.0);
}

function scheduleHealthRespawn() {
    s.healthRespawnTimer = 8 + s.rng() * 5;
    s.healthRespawnX = WALL * 2 + s.rng() * (W - WALL * 4);
    s.healthRespawnY = WALL * 2 + s.rng() * (H - WALL * 4);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nearestZombie() {
    const p = s.player;
    return s.zombies.reduce((best, z) => {
        const d = Math.hypot(z.x-p.x, z.y-p.y);
        return (!best || d < Math.hypot(best.x-p.x, best.y-p.y)) ? z : best;
    }, null);
}

function nearestItemIndex(maxDist = Infinity) {
    const p = s.player;
    let bi = -1, bd = maxDist;
    s.items.forEach((it, i) => {
        const d = Math.hypot(it.x-p.x, it.y-p.y);
        if (d < bd) { bd = d; bi = i; }
    });
    return bi;
}

// ─── Particles ───────────────────────────────────────────────────────────────

function spawnParticles(x, y, color, count, life) {
    for (let i = 0; i < count; i++) {
        const angle = Math.random()*Math.PI*2;
        const spd   = 30 + Math.random()*80;
        s.particles.push({
            x, y,
            vx: Math.cos(angle)*spd, vy: Math.sin(angle)*spd,
            color, life, maxLife: life,
            size: 2 + Math.random()*4,
        });
    }
}

// ─── Floating messages ────────────────────────────────────────────────────────

function showMsg(text, x, y, color, duration) {
    s.messages.push({ text, x, y, color, life: duration, maxLife: duration });
}

// ─── Update ──────────────────────────────────────────────────────────────────

function updateGame(dt) {
    const p = s.player;

    // Timers
    s.time      += dt;
    p.cooldown   = Math.max(0, p.cooldown - dt);
    p.invincible = Math.max(0, p.invincible - dt);
    s.flashTimer = Math.max(0, s.flashTimer - dt);

    // Wave management
    if (s.waveDelay > 0) {
        s.waveDelay -= dt;
        if (s.waveDelay <= 0) startNextWave();
    } else if (s.wave === 0) {
        // First wave starts right away
        startNextWave();
    } else {
        maybeSpawnZombie(dt);
        // Check wave clear
        if (s.waveSpawned >= s.waveZombies && s.waveAlive === 0) {
            const bonus = s.wave * 50;
            s.score += bonus;
            showMsg(`Wave ${s.wave} clear! +${bonus} ⭐`, W/2, H/2 - 40, '#c026d3', 2.0);
            if (s.wave % 3 === 0) spawnStartItems(); // replenish items
            s.waveDelay = 3.5;
        }
    }

    // Health respawn timer
    if (s.healthRespawnTimer > 0) {
        s.healthRespawnTimer -= dt;
        if (s.healthRespawnTimer <= 0) {
            s.healthRespawnTimer = -1;
            s.items.push({ x: s.healthRespawnX, y: s.healthRespawnY, type: 'health', pulse: 0 });
        }
    }

    // Bot
    s.botFrame++;
    if (s.botFrame % BOT_INTERVAL === 0) {
        runBot();
        // Record episode frame at bot tick rate
        s.episode.frames.push({
            f: s.episodeFrame++,
            t: Math.round(s.time * 1000) / 1000,
            px: Math.round(p.x * 10) / 10,
            py: Math.round(p.y * 10) / 10,
            hp: p.health,
            ammo: p.ammo,
            weapon: p.weapon,
            wave: s.wave,
            score: s.score,
            kills: s.kills,
            zCount: s.zombies.length,
            action: s.botMoveDir || 'none',
        });
    }
    applyMovement(dt);

    // Bullets
    for (let i = s.bullets.length-1; i >= 0; i--) {
        const b = s.bullets[i];
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.life -= dt;
        if (b.life <= 0 || b.x<0 || b.x>W || b.y<0 || b.y>H) {
            s.bullets.splice(i, 1); continue;
        }
        // Bullet vs zombie
        for (let j = s.zombies.length-1; j >= 0; j--) {
            const z = s.zombies[j];
            if (Math.hypot(b.x-z.x, b.y-z.y) < z.size + 3) {
                z.health -= b.damage;
                z.hitFlash = 0.12;
                s.bullets.splice(i, 1);
                if (z.health <= 0) killZombie(j);
                break;
            }
        }
    }

    // Zombies
    for (const z of s.zombies) {
        z.wobble  += dt * (z.type==='fast' ? 8 : 5);
        z.hitFlash = Math.max(0, z.hitFlash - dt);
        // Chase player
        const dx = p.x - z.x, dy = p.y - z.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0) {
            z.x += (dx/dist) * z.speed * dt;
            z.y += (dy/dist) * z.speed * dt;
        }
        // Zombie hits player
        if (dist < z.size + 12 && p.invincible <= 0) {
            p.health    -= z.damage;
            p.invincible = 0.6;
            s.flashTimer = 0.2;
            logEpisodeEvent('player_hit', { damage: z.damage, hpAfter: p.health });
            spawnParticles(p.x, p.y, '#fda4af', 8, 0.4);
            if (p.health <= 0) { p.health = 0; gameOver(); return; }
        }
    }

    // Particles
    for (let i = s.particles.length-1; i >= 0; i--) {
        const pt = s.particles[i];
        pt.x += pt.vx * dt; pt.y += pt.vy * dt;
        pt.vx *= 0.9; pt.vy *= 0.9;
        pt.life -= dt;
        if (pt.life <= 0) s.particles.splice(i, 1);
    }

    // Messages
    for (let i = s.messages.length-1; i >= 0; i--) {
        const m = s.messages[i];
        m.y   -= 28 * dt;
        m.life -= dt;
        if (m.life <= 0) s.messages.splice(i, 1);
    }

    // Score: 1pt per second alive
    if (Math.floor(s.time) > Math.floor(s.time - dt)) s.score += 1;
}

function killZombie(idx) {
    const z = s.zombies[idx];
    s.kills++;
    s.score  += s.wave * 10;
    s.waveAlive--;
    logEpisodeEvent('zombie_kill', { zType: z.type, score: s.wave * 10 });
    spawnParticles(z.x, z.y, z.color, 14, 0.6);
    spawnParticles(z.x, z.y, '#fff', 6, 0.3);
    // Random motivational message
    if (s.rng() > 0.6) showMsg(MOTIVATIONAL[Math.floor(s.rng()*MOTIVATIONAL.length)], z.x, z.y - 20, '#c026d3', 1.2);
    // Rare item drop
    if (s.rng() > 0.75) {
        const types = ['health', 'pistol', 'shotgun'];
        s.items.push({ x:z.x, y:z.y, type:types[Math.floor(s.rng()*types.length)], pulse:0 });
    }
    s.zombies.splice(idx, 1);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function render(frame) {
    ctx.clearRect(0, 0, W, H);

    drawArena();
    drawItems(frame);
    drawBullets();
    drawZombies(frame);
    drawPlayer(frame);
    drawParticles();
    drawMessages();

    // Damage flash overlay
    if (s.flashTimer > 0) {
        ctx.fillStyle = `rgba(255,80,120,${(s.flashTimer / 0.2) * 0.3})`;
        ctx.fillRect(0, 0, W, H);
    }
}

function drawArena() {
    // Checkerboard floor
    for (let gx = 0; gx < GRID; gx++) {
        for (let gy = 0; gy < GRID; gy++) {
            const isWall = gx === 0 || gy === 0 || gx === GRID-1 || gy === GRID-1;
            ctx.fillStyle = isWall
                ? (gx+gy)%2===0 ? '#fecdd3' : '#fda4af'
                : (gx+gy)%2===0 ? '#fff0f4' : '#fff5f7';
            ctx.fillRect(gx*TILE, gy*TILE, TILE, TILE);
        }
    }
    // Wall top border stripe
    ctx.fillStyle = 'rgba(244,114,182,0.15)';
    ctx.fillRect(0, 0, W, TILE);
    ctx.fillRect(0, H-TILE, W, TILE);
    ctx.fillRect(0, 0, TILE, H);
    ctx.fillRect(W-TILE, 0, TILE, H);
}

function drawItems(frame) {
    for (const it of s.items) {
        it.pulse += 0.06;
        const sc = 1 + 0.08 * Math.sin(it.pulse);

        ctx.save();
        ctx.translate(it.x, it.y);
        ctx.scale(sc, sc);

        if (it.type === 'health') {
            drawHeart(0, 0, 9, '#ef4444');
        } else {
            // Weapon gem
            const col = WEAPONS[it.type]?.color ?? '#c4b5fd';
            ctx.shadowColor = col;
            ctx.shadowBlur  = 10;
            ctx.fillStyle   = col;
            ctx.beginPath();
            // Diamond shape
            ctx.moveTo(0, -10); ctx.lineTo(8, 0); ctx.lineTo(0, 10); ctx.lineTo(-8, 0);
            ctx.closePath();
            ctx.fill();
            ctx.shadowBlur = 0;
            // Label
            ctx.fillStyle = '#1e0933';
            ctx.font = '7px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(it.type[0].toUpperCase(), 0, 0);
        }
        ctx.restore();
    }
}

function drawHeart(x, y, r, color) {
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 8;
    ctx.beginPath();
    ctx.moveTo(x, y + r*0.5);
    ctx.bezierCurveTo(x - r*1.2, y - r*0.4, x - r*1.2, y - r*1.2, x, y - r*0.5);
    ctx.bezierCurveTo(x + r*1.2, y - r*1.2, x + r*1.2, y - r*0.4, x, y + r*0.5);
    ctx.fill();
    ctx.shadowBlur = 0;
}

function drawBullets() {
    for (const b of s.bullets) {
        const col = WEAPONS[b.weapon]?.color ?? '#fbbf24';
        ctx.beginPath();
        ctx.arc(b.x, b.y, 4, 0, Math.PI*2);
        ctx.fillStyle = col;
        ctx.shadowColor = col;
        ctx.shadowBlur  = 8;
        ctx.fill();
    }
    ctx.shadowBlur = 0;
}

function drawZombies(frame) {
    for (const z of s.zombies) {
        const wobbleY = Math.sin(z.wobble) * 2;

        ctx.save();
        ctx.translate(z.x, z.y + wobbleY);

        if (z.hitFlash > 0) { ctx.shadowColor='#fff'; ctx.shadowBlur=18; }
        else if (z.type==='boss') { ctx.shadowColor=z.color; ctx.shadowBlur=20; }

        // Body
        ctx.fillStyle = z.color;
        ctx.beginPath();
        ctx.arc(0, 0, z.size, 0, Math.PI*2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Highlight
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.beginPath();
        ctx.arc(-z.size*0.3, -z.size*0.3, z.size*0.35, 0, Math.PI*2);
        ctx.fill();

        // X eyes (kawaii zombie 🧟‍♀️)
        const esc = z.size / 14;
        ctx.strokeStyle = z.type==='boss' ? '#fff' : '#4a1d96';
        ctx.lineWidth = 1.5 * esc;
        ctx.lineCap = 'round';
        for (const [ex, ey] of [[-5*esc, -4*esc],[5*esc, -4*esc]]) {
            const s2 = 3*esc;
            ctx.beginPath(); ctx.moveTo(ex-s2, ey-s2); ctx.lineTo(ex+s2, ey+s2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(ex+s2, ey-s2); ctx.lineTo(ex-s2, ey+s2); ctx.stroke();
        }
        // Cute smile
        ctx.beginPath();
        ctx.arc(0, 3*esc, 5*esc, 0.1, Math.PI-0.1);
        ctx.stroke();

        // Health bar
        if (z.health < z.maxHealth) {
            const bw = z.size*2.2;
            ctx.fillStyle = '#fecdd3';
            ctx.fillRect(-bw/2, z.size+3, bw, 3);
            ctx.fillStyle = '#ec4899';
            ctx.fillRect(-bw/2, z.size+3, bw*(z.health/z.maxHealth), 3);
        }

        ctx.restore();
    }
}

function drawPlayer(frame) {
    const p = s.player;
    // Blink when invincible
    if (p.invincible > 0 && Math.floor(p.invincible*12)%2 === 0) return;

    ctx.save();
    ctx.translate(p.x, p.y);

    // Glow
    ctx.shadowColor = '#f472b6';
    ctx.shadowBlur  = 18;

    // Body
    ctx.fillStyle = '#f472b6';
    ctx.beginPath();
    ctx.arc(0, 0, 13, 0, Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Shine
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(-4, -4, 5, 0, Math.PI*2);
    ctx.fill();

    // Rotate toward facing direction to draw eyes in right position
    ctx.rotate(p.facing);

    // Eyes (white)
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(8, -4, 3.5, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(8,  4, 3.5, 0, Math.PI*2); ctx.fill();
    // Pupils
    ctx.fillStyle = '#be185d';
    ctx.beginPath(); ctx.arc(9.5, -4, 1.8, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(9.5,  4, 1.8, 0, Math.PI*2); ctx.fill();

    ctx.restore();
}

function drawParticles() {
    for (const pt of s.particles) {
        const alpha = pt.life / pt.maxLife;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.size * alpha, 0, Math.PI*2);
        ctx.fillStyle = pt.color + Math.round(alpha*255).toString(16).padStart(2,'0');
        ctx.fill();
    }
}

function drawMessages() {
    ctx.textAlign = 'center';
    for (const m of s.messages) {
        const alpha = Math.min(1, m.life / m.maxLife * 2);
        ctx.globalAlpha = alpha;
        ctx.font = 'bold 15px system-ui';
        ctx.fillStyle = m.color;
        ctx.shadowColor = m.color;
        ctx.shadowBlur  = 8;
        ctx.fillText(m.text, m.x, m.y);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur  = 0;
}

// ─── UI updates ───────────────────────────────────────────────────────────────

function updateUI() {
    const p = s.player;

    // Hearts
    const full  = Math.ceil(p.health / 10);
    const empty = 10 - full;
    document.getElementById('hearts').textContent = '❤️'.repeat(Math.max(0,full)) + '🤍'.repeat(Math.max(0,empty));
    document.getElementById('hp-text').textContent = `${p.health} / ${p.maxHealth}`;

    // Stats
    document.getElementById('stat-wave').textContent  = s.wave || '—';
    document.getElementById('stat-score').textContent = s.score.toLocaleString();
    document.getElementById('stat-kills').textContent = s.kills;

    const m  = Math.floor(s.time / 60);
    const sc = Math.floor(s.time % 60).toString().padStart(2,'0');
    document.getElementById('stat-time').textContent = `${m}:${sc}`;

    const wp = WEAPONS[p.weapon];
    document.getElementById('stat-weapon').textContent = wp?.label ?? 'None';
    document.getElementById('stat-ammo').textContent   = `${p.ammo} / ${p.maxAmmo}`;
}

function updateBotStatus(type, msg) {
    const el = document.getElementById('bot-status-text');
    el.className = type === 'ok' ? 'status-ok' : type === 'err' ? 'status-err' : 'status-idle';
    el.textContent = msg;
}

// ─── Game flow ────────────────────────────────────────────────────────────────

function gameOver() {
    s.phase = 'gameover';
    logEpisodeEvent('game_over', { score: s.score, wave: s.wave, kills: s.kills, time: Math.round(s.time * 1000) / 1000 });

    const title = document.getElementById('overlay-title');
    const msg   = document.getElementById('overlay-msg');
    const score = document.getElementById('overlay-score');
    const btn   = document.getElementById('overlay-btn');
    const ov    = document.getElementById('canvas-overlay');

    title.textContent = '💔 Game Over';
    msg.textContent   = `You survived ${s.wave} wave${s.wave!==1?'s':''}!`;
    score.style.display = 'block';
    score.textContent = `Score: ${s.score.toLocaleString()} · Kills: ${s.kills}`;
    btn.textContent   = '▶ Play Again';
    ov.classList.remove('hidden');

    updateBotStatus('idle', 'Game over');
    setTimeout(() => showSubmitModal(), 500);
}

function showIdleOverlay() {
    const ov = document.getElementById('canvas-overlay');
    document.getElementById('overlay-title').textContent   = 'LoveSpark Boxhead';
    document.getElementById('overlay-msg').textContent     = 'Write your bot code below, then click Start! 🩷';
    document.getElementById('overlay-score').style.display = 'none';
    document.getElementById('overlay-btn').textContent     = '▶ Start Game';
    ov.classList.remove('hidden');
    updateBotStatus('idle', 'Waiting to start…');
}

function startGame(seed) {
    resetGame();
    s.seed = seed != null ? (seed >>> 0) : newSeed();
    s.rng  = makeRng(s.seed);
    spawnStartItems();
    compileBotCode();
    s.phase = 'playing';

    // Episode meta
    s.episode.meta = {
        seed:      s.seed,
        botHash:   '',
        startedAt: new Date().toISOString(),
    };
    computeBotHash(getEditorCode()).then(h => { s.episode.meta.botHash = h; });

    // Update seed display
    const seedInput = document.getElementById('seed-input');
    if (seedInput) seedInput.value = s.seed;

    document.getElementById('canvas-overlay').classList.add('hidden');
    updateBotStatus('ok', '✅ Bot loaded');
}

function parseSeedInput() {
    const el = document.getElementById('seed-input');
    if (!el || !el.value.trim()) return undefined;
    const val = parseInt(el.value, 10);
    return isNaN(val) ? undefined : val;
}

function handleOverlayBtn() {
    if (s.phase === 'gameover' || s.phase === 'idle') startGame(parseSeedInput());
}

function handleStartBtn() {
    startGame(parseSeedInput());
}

function applyAndStart() {
    saveCode();
    startGame(parseSeedInput());
}

function handleNewSeed() {
    startGame();
}

function handleRerunSeed() {
    startGame(s.seed || newSeed());
}

function handleExportEpisode() {
    if (!s.episode || s.episode.frames.length === 0) return;
    const json = JSON.stringify(s.episode, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `episode-${s.seed}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

// ─── Bot compilation ─────────────────────────────────────────────────────────

function compileBotCode() {
    s.botFn    = null;
    s.botError = null;
    const code = getEditorCode();

    try {
        // Wrap in an isolated scope — no direct DOM/global access needed
        // eslint-disable-next-line no-new-func
        const wrapped = new Function(`
            "use strict";
            ${code}
            if (typeof myAgent !== 'function') throw new Error("myAgent function not found");
            return myAgent;
        `);
        s.botFn = wrapped();
        updateBotStatus('ok', '✅ Bot compiled OK');
    } catch(e) {
        s.botError = e.message;
        updateBotStatus('err', '❌ ' + e.message);
    }
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

const LB_KEY = 'lsb_scores';

function getScores() {
    try { return JSON.parse(localStorage.getItem(LB_KEY) || '[]'); }
    catch { return []; }
}

function saveScore(name) {
    const scores = getScores();
    scores.push({ name, score:s.score, wave:s.wave, kills:s.kills, time:Math.floor(s.time), date:new Date().toLocaleDateString() });
    scores.sort((a,b) => b.score - a.score);
    scores.splice(10);
    try { localStorage.setItem(LB_KEY, JSON.stringify(scores)); } catch {}
}

function showLeaderboard() {
    const scores = getScores();
    const modal  = document.getElementById('lb-modal');
    const content= document.getElementById('lb-content');

    if (!scores.length) {
        content.innerHTML = '<p class="lb-empty">No scores yet — be the first! 🩷</p>';
    } else {
        const medals = ['🥇','🥈','🥉'];
        const rows   = scores.map((e,i) =>
            `<tr><td>${medals[i]||i+1}</td><td>${e.name}</td><td>${e.score.toLocaleString()}</td><td>${e.wave}</td><td>${e.kills}</td><td>${Math.floor(e.time/60)}:${(e.time%60).toString().padStart(2,'0')}</td><td>${e.date}</td></tr>`
        ).join('');
        content.innerHTML =
            `<table class="lb-table">
                <thead><tr><th>#</th><th>Name</th><th>Score</th><th>Wave</th><th>Kills</th><th>Time</th><th>Date</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>`;
    }
    modal.classList.remove('hidden');
}

function showSubmitModal() {
    document.getElementById('player-name').value = '';
    document.getElementById('submit-modal').classList.remove('hidden');
}

// Exposed to HTML onclick
function submitScore() {
    const name = document.getElementById('player-name').value.trim() || 'Anonymous 🩷';
    saveScore(name);
    document.getElementById('submit-modal').classList.add('hidden');
    showLeaderboard();
}

// ─── Code editor ─────────────────────────────────────────────────────────────

let editor = null;

function initEditor() {
    const ta = document.getElementById('code-editor-fallback');
    const saved = localStorage.getItem('lsb_code');
    ta.value = saved || DEFAULT_CODE;

    if (typeof CodeMirror !== 'undefined') {
        editor = CodeMirror.fromTextArea(ta, {
            mode: 'javascript',
            theme: 'dracula',
            lineNumbers: true,
            tabSize: 2,
            indentUnit: 2,
            lineWrapping: false,
            extraKeys: { 'Ctrl-Enter': applyAndStart, 'Cmd-Enter': applyAndStart },
        });
    }
}

function getEditorCode() {
    return editor ? editor.getValue() : document.getElementById('code-editor-fallback').value;
}

function saveCode() {
    try { localStorage.setItem('lsb_code', getEditorCode()); } catch {}
}

function resetCode() {
    if (editor) editor.setValue(DEFAULT_CODE);
    else document.getElementById('code-editor-fallback').value = DEFAULT_CODE;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

let lastTime = null;
let frameCount = 0;

function loop(ts) {
    requestAnimationFrame(loop);

    const dt = lastTime == null ? 0 : Math.min((ts - lastTime) / 1000, 0.05);
    lastTime  = ts;
    frameCount++;

    if (s.phase === 'playing') {
        updateGame(dt);
        updateUI();
    }
    render(frameCount);
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        applyAndStart();
    }
});

// ─── Init ────────────────────────────────────────────────────────────────────

function init() {
    const canvas = document.getElementById('gameCanvas');
    ctx = canvas.getContext('2d');

    resetGame();
    initEditor();
    showIdleOverlay();
    requestAnimationFrame(loop);
}

// Wait for DOM + scripts
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
