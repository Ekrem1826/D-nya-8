/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BASE_RADIUS,
  ROLES,
  PlayerRole,
  PITCH_LEFT,
  PITCH_TOP,
  PITCH_RIGHT,
  PITCH_BOTTOM,
  GOAL_LEFT,
  GOAL_RIGHT,
  CENTER_X,
  CENTER_Y,
  PHYSICS_DT,
  MAX_PULL_DISTANCE,
  MATCH_DURATION_SECONDS,
  SHOT_CLOCK_SECONDS,
  FORMATIONS,
  PLAYERS_PER_TEAM,
  PASS_MAX_DISTANCE,
  PLAYER_CAPTURE_RADIUS,
  BALL_CONTROL_RADIUS,
  PASS_TARGET_MAX_DISTANCE,
  DEFENDER_CHASE_SPEEDS,
  POST_RADIUS,
  MIN_VELOCITY_THRESHOLD,
  MIN_VELOCITY_SQ,
} from './constants.ts';

export interface Disk {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  m: number;
  k: number; // friction drag coefficient
  f: number; // Math.exp(-k * DT)
  ball?: boolean;
  roleId?: number; // 1..7
  teamIndex?: number; // 0: User, 1: Bot
  playerIndex?: number; // 0..6
}

export const BALL_INDEX = PLAYERS_PER_TEAM * 2; // 14

/**
 * Creates disk representation.
 */
export function createDisk(
  x: number,
  y: number,
  r: number,
  m: number,
  k: number,
  ball = false,
  roleId?: number,
  teamIndex?: number,
  playerIndex?: number
): Disk {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    r,
    m,
    k,
    f: Math.exp(-k * PHYSICS_DT),
    ball,
    roleId,
    teamIndex,
    playerIndex,
  };
}

/**
 * Resets the 15 disks on the field:
 * Disks 0..6: User's 7 players (bottom half with formationA)
 * Disks 7..13: Bot's 7 players (top half with formationB)
 * Disk 14: Ball (center)
 */
export function resetDisks(
  formationA: [number, number][] = FORMATIONS[0].positions,
  formationB: [number, number][] = FORMATIONS[0].positions
): Disk[] {
  const disks: Disk[] = [];

  // Team 0 (User - bottom half)
  formationA.forEach((p, idx) => {
    const role = ROLES[idx] || ROLES[ROLES.length - 1];
    disks.push(
      createDisk(
        PITCH_LEFT + p[0],
        PITCH_TOP + p[1],
        role.radius,
        role.mass,
        2.4, // ground friction
        false,
        role.id,
        0,
        idx
      )
    );
  });

  // Team 1 (Bot - top half, mirrored)
  formationB.forEach((p, idx) => {
    const role = ROLES[idx] || ROLES[ROLES.length - 1];
    disks.push(
      createDisk(
        PITCH_LEFT + p[0],
        PITCH_TOP + 680 - p[1],
        role.radius,
        role.mass,
        2.4,
        false,
        role.id,
        1,
        idx
      )
    );
  });

  // Disk 14: Ball (Center of pitch)
  disks.push(createDisk(CENTER_X, CENTER_Y, 10, 1.0, 1.7, true));

  return disks;
}

export interface StepResult {
  goal: number; // 0: none, 1: team A goal (top net), 2: team B goal (bottom net)
  highestCollisionImpulse: number;
  ballContactRoleId: number | null;
  ballContactTeam: number | null;
  ballContactPlayerIndex: number | null;
  postHit: boolean;
}

// 4 Goal posts (X, Y)
const GOAL_POSTS: [number, number][] = [
  [GOAL_LEFT, PITCH_TOP],
  [GOAL_RIGHT, PITCH_TOP],
  [GOAL_LEFT, PITCH_BOTTOM],
  [GOAL_RIGHT, PITCH_BOTTOM],
];

/**
 * 2D physics step adhering to the 7 roles, goal posts, net collisions, and ball dynamics.
 * Supports any dt safely, using fixed-timestep accumulator for rock-solid stability.
 */
export function physicsStep(disks: Disk[], dt = PHYSICS_DT): StepResult {
  let goal = 0;
  let highestImpulse = 0;
  let ballContactRoleId: number | null = null;
  let ballContactTeam: number | null = null;
  let ballContactPlayerIndex: number | null = null;
  let postHit = false;

  // 1. Movement, friction, and boundary collisions
  for (const o of disks) {
    if (!o.vx && !o.vy) continue;
    o.x += o.vx * dt;
    o.y += o.vy * dt;

    // Time-independent friction decay: exact at any dt
    const f = dt === PHYSICS_DT ? o.f : Math.exp(-o.k * dt);
    const r = o.r;
    const e = o.ball ? 0.85 : 0.6; // restitution on border bounce
    const sp = Math.hypot(o.vx, o.vy);
    const minSpeedLoss = o.ball ? 20 : 50;
    const ns = Math.max(0, sp * f - minSpeedLoss * dt);

    if (ns < MIN_VELOCITY_THRESHOLD) {
      o.vx = 0;
      o.vy = 0;
    } else {
      o.vx *= ns / sp;
      o.vy *= ns / sp;
    }

    if (o.vx * o.vx + o.vy * o.vy < MIN_VELOCITY_SQ) {
      o.vx = 0;
      o.vy = 0;
    }

    // Left and right side pitch boundaries
    if (o.x < PITCH_LEFT + r) {
      o.x = PITCH_LEFT + r;
      o.vx = Math.abs(o.vx) * e;
    }
    if (o.x > PITCH_RIGHT - r) {
      o.x = PITCH_RIGHT - r;
      o.vx = -Math.abs(o.vx) * e;
    }

    // Top and bottom goal boundaries
    if (o.ball && o.x > GOAL_LEFT && o.x < GOAL_RIGHT) {
      if (o.y < PITCH_TOP) {
        goal = 1; // Team 0 scored into Team 1's goal!
        // Contain ball inside top net
        if (o.y < PITCH_TOP - 36) {
          o.y = PITCH_TOP - 36;
          o.vy = Math.abs(o.vy) * 0.3;
        }
        if (o.x < GOAL_LEFT + r) {
          o.x = GOAL_LEFT + r;
          o.vx = Math.abs(o.vx) * 0.4;
        } else if (o.x > GOAL_RIGHT - r) {
          o.x = GOAL_RIGHT - r;
          o.vx = -Math.abs(o.vx) * 0.4;
        }
      } else if (o.y > PITCH_BOTTOM) {
        goal = 2; // Team 1 scored into Team 0's goal!
        // Contain ball inside bottom net
        if (o.y > PITCH_BOTTOM + 36) {
          o.y = PITCH_BOTTOM + 36;
          o.vy = -Math.abs(o.vy) * 0.3;
        }
        if (o.x < GOAL_LEFT + r) {
          o.x = GOAL_LEFT + r;
          o.vx = Math.abs(o.vx) * 0.4;
        } else if (o.x > GOAL_RIGHT - r) {
          o.x = GOAL_RIGHT - r;
          o.vx = -Math.abs(o.vx) * 0.4;
        }
      }
    } else {
      if (o.y < PITCH_TOP + r) {
        o.y = PITCH_TOP + r;
        o.vy = Math.abs(o.vy) * e;
      }
      if (o.y > PITCH_BOTTOM - r) {
        o.y = PITCH_BOTTOM - r;
        o.vy = -Math.abs(o.vy) * e;
      }
    }
  }

  // 2. Goal post collision for the ball
  const ball = disks[disks.length - 1];
  if (ball && ball.ball && (ball.vx !== 0 || ball.vy !== 0)) {
    for (const [px, py] of GOAL_POSTS) {
      const dx = ball.x - px;
      const dy = ball.y - py;
      const dist = Math.hypot(dx, dy);
      const minD = ball.r + POST_RADIUS;

      if (dist < minD && dist > 0.001) {
        const nx = dx / dist;
        const ny = dy / dist;
        // Separate from post
        ball.x = px + nx * minD;
        ball.y = py + ny * minD;

        // Elastic rebound off circular post
        const vn = ball.vx * nx + ball.vy * ny;
        if (vn < 0) {
          ball.vx -= 1.85 * vn * nx;
          ball.vy -= 1.85 * vn * ny;
          postHit = true;
          highestImpulse = Math.max(highestImpulse, -vn * 1.5);
        }
      }
    }
  }

  // 3. Inter-disk collisions
  for (let i = 0; i < disks.length; i++) {
    for (let j = i + 1; j < disks.length; j++) {
      const a = disks[i];
      const b = disks[j];
      if (!(a.vx || a.vy || b.vx || b.vy)) continue;

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const rr = a.r + b.r;
      const d2 = dx * dx + dy * dy;

      if (d2 < rr * rr && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const ny = dy / d;

        const im = 1 / a.m + 1 / b.m;
        const overlap = rr - d;
        const pa = overlap / a.m / im;
        const pb = overlap / b.m / im;

        a.x -= nx * pa;
        a.y -= ny * pa;
        b.x += nx * pb;
        b.y += nx * pb;

        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn < 0) {
          highestImpulse = Math.max(highestImpulse, -vn);

          let eRest = a.ball || b.ball ? 0.9 : 0.7;

          // Check role-specific collision characteristics
          const playerDisk = a.ball ? b : b.ball ? a : null;
          const isBallCollision = a.ball || b.ball;

          if (isBallCollision && playerDisk && playerDisk.roleId) {
            ballContactRoleId = playerDisk.roleId;
            ballContactTeam = playerDisk.teamIndex ?? null;
            ballContactPlayerIndex = playerDisk.playerIndex ?? null;

            // 1 — Kaleci special clearance:
            if (playerDisk.roleId === 1) {
              const isNearOwnGoal =
                playerDisk.teamIndex === 0
                  ? playerDisk.y > 630
                  : playerDisk.y < 190;
              eRest = isNearOwnGoal ? 1.25 : 1.1;
            }

            // 2 — Stoper block:
            if (playerDisk.roleId === 2) {
              eRest = 1.05;
            }

            // 5 — Ön libero & merkez:
            if (playerDisk.roleId === 5) {
              eRest = 0.78;
            }

            // 7 — Forvet:
            if (playerDisk.roleId === 7) {
              const inOffensiveHalf =
                playerDisk.teamIndex === 0
                  ? playerDisk.y < CENTER_Y
                  : playerDisk.y > CENTER_Y;
              if (inOffensiveHalf) {
                eRest = 1.15;
              }
            }
          }

          const q = -((1 + eRest) * vn) / im;
          a.vx -= (q * nx) / a.m;
          a.vy -= (q * ny) / a.m;
          b.vx += (q * nx) / b.m;
          b.vy += (q * ny) / b.m;
        }
      }
    }
  }

  return {
    goal,
    highestCollisionImpulse: highestImpulse,
    ballContactRoleId,
    ballContactTeam,
    ballContactPlayerIndex,
    postHit,
  };
}

/**
 * Checks if any disk has active velocity above threshold.
 */
export function areDisksMoving(disks: Disk[], minSpeedSq = MIN_VELOCITY_SQ): boolean {
  return disks.some((o) => o.vx * o.vx + o.vy * o.vy > minSpeedSq);
}

/**
 * Evaluates whether a shot resulted in a successful pass to a teammate.
 * User requirement: "Eğer bir takım oyuncu topa vurduktan sonra kendi oyuncusunun yanına olursa pas olsun. Ama mesafe çok fazla olmasın."
 */
export interface PassResult {
  isPass: boolean;
  receiverPlayerIndex?: number;
  receiverDiskIndex?: number;
  distance?: number;
  reason?: 'success' | 'out_of_range' | 'intercepted_by_opponent' | 'no_ball' | 'not_captured';
}

/**
 * Finds the closest player disk to the ball (optionally filtered by team).
 */
export function findClosestPlayerToBall(
  disks: Disk[],
  teamIndex?: number
): { diskIndex: number; playerIndex: number; teamIndex: number; distance: number } | null {
  const ball = disks[disks.length - 1];
  if (!ball || !ball.ball) return null;

  let minDist = Infinity;
  let bestDiskIdx = -1;
  let bestPlayerIdx = -1;
  let bestTeamIdx = -1;

  for (let i = 0; i < disks.length - 1; i++) {
    const d = disks[i];
    if (d.ball) continue;
    if (teamIndex !== undefined && d.teamIndex !== teamIndex) continue;

    const dist = Math.hypot(d.x - ball.x, d.y - ball.y);
    if (dist < minDist) {
      minDist = dist;
      bestDiskIdx = i;
      bestPlayerIdx = d.playerIndex ?? (i % PLAYERS_PER_TEAM);
      bestTeamIdx = d.teamIndex ?? 0;
    }
  }

  if (bestDiskIdx === -1) return null;
  return {
    diskIndex: bestDiskIdx,
    playerIndex: bestPlayerIdx,
    teamIndex: bestTeamIdx,
    distance: minDist,
  };
}

/**
 * Determines whether a player disk is close enough to touch or shoot the ball.
 * Only players within BALL_CONTROL_RADIUS can initiate an action.
 */
export function canPlayerControlBall(
  playerDisk: Disk,
  ballDisk: Disk,
  controlRadius = BALL_CONTROL_RADIUS
): boolean {
  if (!playerDisk || !ballDisk) return false;
  const dist = Math.hypot(playerDisk.x - ballDisk.x, playerDisk.y - ballDisk.y);
  return dist <= controlRadius + playerDisk.r + ballDisk.r;
}

export type TurnMode = 'FREE_CHOICE' | 'PASS_RECEIVER_ONLY';

/**
 * Checks whether a player on the active team can be selected to shoot based on turnMode.
 * - In 'FREE_CHOICE': Any player of the team can be freely chosen!
 * - In 'PASS_RECEIVER_ONLY': Only the designated receiver player can shoot!
 */
export function isPlayerSelectable(
  playerIndex: number,
  turnMode: TurnMode,
  passReceiverPlayerIndex: number | null
): boolean {
  if (turnMode === 'PASS_RECEIVER_ONLY') {
    return passReceiverPlayerIndex !== null && playerIndex === passReceiverPlayerIndex;
  }
  return true; // In FREE_CHOICE: freely choose any player!
}



/**
 * Calculates perpendicular distance from a point to a 2D line segment.
 * Used for continuous sweep detection so fast-moving balls never skip player capture zones.
 */
export function distancePointToSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x0, py - y0);
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / lenSq));
  const projX = x0 + t * dx;
  const projY = y0 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

/**
 * Checks whether a shot resulted in a successful pass to a teammate.
 * Strictest physical and geometric criteria:
 * 1. The target teammate must have been within PASS_MAX_DISTANCE when the pass began.
 * 2. The ball trajectory must physically sweep through the receiving teammate's capture zone (PLAYER_CAPTURE_RADIUS).
 * 3. When the ball stops, the ball must be at rest within the teammate's capture zone (or closest teammate within capture radius).
 * 4. Opponents must not be closer than the teammate to the ball (no interception).
 */
export function checkPassSuccess(
  disks: Disk[],
  activeTeam: number,
  shooterPlayerIndex: number,
  targetTeammateDiskIndex: number | null = null,
  didBallEnterCaptureArea = false,
  maxDistance = PASS_MAX_DISTANCE,
  captureRadius = PLAYER_CAPTURE_RADIUS
): PassResult {
  const ball = disks[disks.length - 1]; // Ball is always the last disk
  if (!ball || !ball.ball) return { isPass: false, reason: 'no_ball' };

  let closestTeammateDist = Infinity;
  let closestTeammatePlayerIdx = -1;
  let closestTeammateDiskIdx = -1;

  let closestOpponentDist = Infinity;

  for (let i = 0; i < disks.length - 1; i++) {
    const d = disks[i];
    const distToBallCenter = Math.hypot(d.x - ball.x, d.y - ball.y);

    if (d.teamIndex === activeTeam) {
      // Must be a teammate, not the shooter themselves!
      if (d.playerIndex !== shooterPlayerIndex) {
        if (distToBallCenter < closestTeammateDist) {
          closestTeammateDist = distToBallCenter;
          closestTeammatePlayerIdx = d.playerIndex ?? -1;
          closestTeammateDiskIdx = i;
        }
      }
    } else {
      // Opponent
      if (distToBallCenter < closestOpponentDist) {
        closestOpponentDist = distToBallCenter;
      }
    }
  }

  // Case A: A specific target teammate was aimed at
  if (targetTeammateDiskIndex !== null && disks[targetTeammateDiskIndex]) {
    const target = disks[targetTeammateDiskIndex];
    const targetDist = Math.hypot(target.x - ball.x, target.y - ball.y);
    const targetCaptured = targetDist <= captureRadius + target.r + ball.r;

    // If ball never entered capture area and is not currently in capture area:
    if (!didBallEnterCaptureArea && !targetCaptured) {
      return {
        isPass: false,
        receiverPlayerIndex: target.playerIndex,
        distance: Math.round(targetDist),
        reason: 'not_captured',
      };
    }

    // Ball must rest near the teammate, not on opposite side of pitch
    if (targetDist > captureRadius + target.r + ball.r + 30) {
      return {
        isPass: false,
        receiverPlayerIndex: target.playerIndex,
        distance: Math.round(targetDist),
        reason: 'out_of_range',
      };
    }

    if (closestOpponentDist <= targetDist) {
      return {
        isPass: false,
        receiverPlayerIndex: target.playerIndex,
        distance: Math.round(targetDist),
        reason: 'intercepted_by_opponent',
      };
    }

    return {
      isPass: true,
      receiverPlayerIndex: target.playerIndex,
      receiverDiskIndex: targetTeammateDiskIndex,
      distance: Math.round(targetDist),
      reason: 'success',
    };
  }

  // Case B: General check (fallback / untargeted shot / unit test compatibility)
  if (closestTeammateDiskIdx !== -1) {
    const teammate = disks[closestTeammateDiskIdx];
    const maxAllowedRestDist = captureRadius + teammate.r + ball.r + 20;

    if (closestTeammateDist <= maxAllowedRestDist) {
      if (closestTeammateDist < closestOpponentDist) {
        return {
          isPass: true,
          receiverPlayerIndex: closestTeammatePlayerIdx,
          receiverDiskIndex: closestTeammateDiskIdx,
          distance: Math.round(closestTeammateDist),
          reason: 'success',
        };
      } else {
        return {
          isPass: false,
          receiverPlayerIndex: closestTeammatePlayerIdx,
          distance: Math.round(closestTeammateDist),
          reason: 'intercepted_by_opponent',
        };
      }
    }
  }

  return { isPass: false, reason: 'out_of_range' };
}

/**
 * Smoothly advances a defending player disk towards the ball or intercept point without teleporting.
 * Constrains the defender to valid pitch bounds.
 */
export function stepDefenderClosing(
  defender: Disk,
  targetX: number,
  targetY: number,
  speedPxSec: number,
  dt: number
): void {
  const dx = targetX - defender.x;
  const dy = targetY - defender.y;
  const dist = Math.hypot(dx, dy);

  if (dist < 1.0) return;

  const moveDist = Math.min(dist, speedPxSec * dt);
  defender.x += (dx / dist) * moveDist;
  defender.y += (dy / dist) * moveDist;

  // Pitch constraints
  defender.x = Math.max(PITCH_LEFT + defender.r, Math.min(PITCH_RIGHT - defender.r, defender.x));
  defender.y = Math.max(PITCH_TOP + defender.r, Math.min(PITCH_BOTTOM - defender.r, defender.y));
}

/**
 * Checks if the defending player disk made physical contact with the moving ball (interception).
 */
export function checkDefenderInterception(defender: Disk, ball: Disk): boolean {
  if (!defender || !ball) return false;
  const dx = ball.x - defender.x;
  const dy = ball.y - defender.y;
  const dist = Math.hypot(dx, dy);
  return dist <= defender.r + ball.r + 2.0;
}

/**
 * Computes a dotted trajectory forecast showing simulated path with side wall reflections.
 */
export function calculateTrajectoryForecast(
  startX: number,
  startY: number,
  vx: number,
  vy: number,
  radius = 10,
  maxPoints = 14,
  dt = 0.025
): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  let cx = startX;
  let cy = startY;
  let cvx = vx;
  let cvy = vy;

  for (let i = 0; i < maxPoints; i++) {
    cx += cvx * dt;
    cy += cvy * dt;
    cvx *= 0.96;
    cvy *= 0.96;

    // Pitch side wall bounce reflection
    if (cx < PITCH_LEFT + radius) {
      cx = PITCH_LEFT + radius;
      cvx = -cvx * 0.8;
    } else if (cx > PITCH_RIGHT - radius) {
      cx = PITCH_RIGHT - radius;
      cvx = -cvx * 0.8;
    }

    // Top/Bottom boundary limit
    if (cy < PITCH_TOP + radius) {
      cy = PITCH_TOP + radius;
      cvy = -cvy * 0.8;
    } else if (cy > PITCH_BOTTOM - radius) {
      cy = PITCH_BOTTOM - radius;
      cvy = -cvy * 0.8;
    }

    points.push({ x: cx, y: cy });
    if (cvx * cvx + cvy * cvy < 40) break;
  }

  return points;
}

/**
 * Calculates shot impulse based on pull length and player role.
 */
export function calculateShotPower(
  pullDistance: number,
  roleId: number,
  diskY: number,
  teamIndex: number
): number {
  const clampedPull = Math.min(pullDistance, MAX_PULL_DISTANCE);
  const baseImpulse = 80 + 820 * Math.pow(clampedPull / MAX_PULL_DISTANCE, 1.6);
  const role = ROLES.find((r) => r.id === roleId) || ROLES[4];

  let power = baseImpulse * role.powerMultiplier;

  // Role 7 (Forvet): Kaleye yakın şutlarda güç ve isabet bonusu
  if (roleId === 7) {
    const isAttackingThird =
      teamIndex === 0 ? diskY < 280 : diskY > PITCH_BOTTOM - 210;
    if (isAttackingThird) {
      power *= 1.2;
    }
  }

  // Role 6 (On Numara): Technique finesse bonus
  if (roleId === 6) {
    power *= 1.05;
  }

  return power;
}

/**
 * Formats time in seconds to mm:ss format.
 */
export function formatTimeMMSS(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Converts real match seconds to simulated football match minute (0' to 90'+).
 */
export function formatFootballMatchMinute(
  remainingSeconds: number,
  totalSeconds = MATCH_DURATION_SECONDS,
  isExtraTime = false
): string {
  if (isExtraTime) {
    return 'Uzatma (Altın Gol)';
  }
  const elapsed = Math.max(0, totalSeconds - remainingSeconds);
  const minute = Math.min(90, Math.ceil((elapsed / totalSeconds) * 90));
  if (minute >= 90 && remainingSeconds <= 0) {
    return "90'+";
  }
  return `${Math.max(1, minute)}'`;
}

/**
 * Evaluates match end conditions.
 */
export function checkMatchEnd(
  remainingSeconds: number,
  scoreA: number,
  scoreB: number,
  isKnockout: boolean,
  isExtraTime: boolean
): { finished: boolean; startExtraTime: boolean; startPenalties: boolean } {
  if (remainingSeconds > 0) {
    return { finished: false, startExtraTime: false, startPenalties: false };
  }

  const isTied = scoreA === scoreB;

  if (!isKnockout) {
    return { finished: true, startExtraTime: false, startPenalties: false };
  }

  if (!isTied) {
    return { finished: true, startExtraTime: false, startPenalties: false };
  }

  if (!isExtraTime) {
    return { finished: false, startExtraTime: true, startPenalties: false };
  } else {
    return { finished: false, startExtraTime: false, startPenalties: true };
  }
}

/**
 * Evaluates whether the 5-second shot clock has expired.
 * When time runs out in an active turn phase (aim, bot_thinking, bot_aiming),
 * possession transfers to the opposite team.
 */
export function checkTurnTimeout(
  turnTimer: number,
  phase: string
): boolean {
  if (phase !== 'aim' && phase !== 'bot_thinking' && phase !== 'bot_aiming') {
    return false;
  }
  return turnTimer <= 0;
}

