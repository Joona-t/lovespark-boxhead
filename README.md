# 🩷 LoveSpark Boxhead 🧟‍♀️

> A cute pastel zombie survival game where **you write the AI** that controls your character.
> Part of the **LoveSpark Suite** — built for neurodivergent coders who learn through play.

---

## 🎮 How to Play

1. **Open `index.html`** in Chrome or Firefox
2. **Edit your bot** in the code editor at the bottom
3. Click **▶ Apply & Start** (or press `Ctrl+Enter`)
4. Watch your bot survive waves of kawaii zombies 🧟‍♀️
5. Submit your score to the leaderboard 🏆

---

## 🤖 Bot API

Your bot is a single JavaScript function called **`myAgent`**.
It is called ~10 times per second and must return one action string.

```js
function myAgent(gameState) {
  // ... your logic ...
  return "shoot"; // one action per call
}
```

### `gameState` object

| Field | Type | Description |
|-------|------|-------------|
| `myHealth` | `number` | Your current HP (0–100) |
| `myPosition` | `{x, y}` | Your grid position (0–20) |
| `myWeapon` | `string` | `"pistol"` \| `"shotgun"` \| `"rifle"` \| `"none"` |
| `ammo` | `number` | Rounds remaining |
| `nearbyZombies` | `Array` | `[{x, y, health, distance}, …]` sorted nearest-first |
| `nearbyWeapons` | `Array` | `[{x, y, type, distance}, …]` sorted nearest-first |
| `nearbyHealth` | `Array` | `[{x, y, distance}, …]` sorted nearest-first |
| `wave` | `number` | Current wave number |
| `score` | `number` | Current score |
| `kills` | `number` | Total zombie kills |

### Actions

| Return value | Effect |
|-------------|--------|
| `"moveUp"` | Move up continuously |
| `"moveDown"` | Move down continuously |
| `"moveLeft"` | Move left continuously |
| `"moveRight"` | Move right continuously |
| `"shoot"` | Fire at the nearest zombie |
| `"pickup"` | Grab the nearest item (weapon or health) |
| `"reload"` | Refill ammo for current weapon |
| `"retreat"` | Auto-move directly away from nearest zombie |
| `"explore"` | Move toward nearest item, or wander if none |

> **Tip:** Movement actions persist until you return a different movement.
> Instant actions (`shoot`, `pickup`, `reload`) happen once per call.

---

## ⚔️ Weapons

| Weapon | Damage | Ammo | Fire Rate | Notes |
|--------|--------|------|-----------|-------|
| Pistol 🔫 | 10 | 12 | Fast | Starter weapon |
| Shotgun 💥 | 22 ×3 | 6 | Slow | 3 pellets, wide spread |
| Rifle 🎯 | 18 | 20 | Medium | Long range, precise |

---

## 🌊 Wave Scaling

| Wave | Zombies | HP | Speed |
|------|---------|-----|-------|
| 1 | 7 | 35 | Slow |
| 3 | 13 | 45 | Medium |
| 5 | 19 | 55 | Fast + **BOSS** 👑 |
| 10 | 34 | 80 | Very fast + **BOSS** 👑 |

Every **5th wave** spawns a boss zombie (3× HP, glowing pink, extra damage).

---

## 📊 Scoring

```
score += wave × 10    per zombie killed
score += 1            per second survived
score += wave × 50    wave clear bonus
```

---

## 💡 Example Strategies

### Starter Bot (safe & simple)
```js
function myAgent({ myHealth, nearbyZombies, ammo, nearbyHealth }) {
  if (myHealth < 40 && nearbyHealth[0]?.distance < 4) return "pickup";
  if (nearbyZombies.length > 0 && ammo > 0) return "shoot";
  if (ammo === 0) return "reload";
  return "explore";
}
```

### Aggressive Bot (high risk, high reward)
```js
function myAgent({ nearbyZombies, ammo, myWeapon }) {
  if (ammo > 0 && nearbyZombies.length > 0) return "shoot";
  if (ammo === 0) return "reload";
  // Always close the gap
  const z = nearbyZombies[0];
  if (!z) return "explore";
  const dx = z.x - myPosition.x;
  const dy = z.y - myPosition.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "moveRight" : "moveLeft";
  return dy > 0 ? "moveDown" : "moveUp";
}
```

### Survivor Bot (defensive kiting)
```js
function myAgent({ myHealth, nearbyZombies, ammo, nearbyHealth, myPosition }) {
  // Always prioritize health
  if (myHealth < 60 && nearbyHealth[0]?.distance < 6) return "pickup";
  // Shoot if safe distance
  const z = nearbyZombies[0];
  if (z && z.distance > 3 && ammo > 0) return "shoot";
  // Retreat if too close
  if (z && z.distance < 3) return "retreat";
  if (ammo === 0) return "reload";
  return "explore";
}
```

---

## 🚀 Deployment (GitHub Pages)

```bash
# In your repo root:
git add lovespark-boxhead/
git commit -m "Add LoveSpark Boxhead 🧟‍♀️"
git push

# Then in GitHub repo settings:
# Settings → Pages → Source: main branch → / (root) or /docs
# Your game will be live at: https://username.github.io/repo/lovespark-boxhead/
```

For a dedicated repo, the game is at `index.html` so GitHub Pages serves it at root automatically.

---

## 🏗️ File Structure

```
lovespark-boxhead/
├── index.html   — Layout, CSS, CodeMirror editor, modal UI
├── game.js      — Full game engine (canvas, physics, bot runner, leaderboard)
└── README.md    — This file
```

---

## 🔒 Security Notes

- Bot code runs via `new Function()` in strict mode — no DOM access needed
- All data (scores, bot code) stored in `localStorage` — nothing sent to servers
- Infinite loops in bot code will freeze the tab; avoid `while(true)`

---

*🩷 LoveSpark Suite · Anti Brainrot · Dreamy Garden · LoveSpark Cards · Dopamine Control*
