// src/team/git-worktree.ts
/**
 * Git worktree manager for team worker isolation.
 *
 * Native team worktrees live at:
 *   {repoRoot}/.omc/team/{team}/worktrees/{worker}
 * Branch naming (branch mode): omc-team/{teamName}/{workerName}
 *
 * The public create/remove helpers are kept for legacy callers, but the
 * implementation is conservative: compatible clean worktrees are reused,
 * dirty team worktrees are preserved, and cleanup never force-removes dirty
 * worker changes.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWriteJson, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import { sanitizeName } from './tmux-session.js';
import { withFileLockSync } from '../lib/file-lock.js';
/** Get canonical native team worktree path for a worker. */
export function getWorktreePath(repoRoot, teamName, workerName) {
    return join(repoRoot, '.omc', 'team', sanitizeName(teamName), 'worktrees', sanitizeName(workerName));
}
/** Get branch name for a worker. */
export function getBranchName(teamName, workerName) {
    return `omc-team/${sanitizeName(teamName)}/${sanitizeName(workerName)}`;
}
function git(repoRoot, args, cwd = repoRoot) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}
function isInsideGitRepo(repoRoot) {
    try {
        git(repoRoot, ['rev-parse', '--show-toplevel']);
        return true;
    }
    catch {
        return false;
    }
}
function assertCleanLeaderWorktree(repoRoot) {
    const status = git(repoRoot, ['status', '--porcelain']);
    if (status.length > 0) {
        const error = new Error('leader_worktree_dirty: commit, stash, or clean changes before enabling team worktree mode');
        error.code = 'leader_worktree_dirty';
        throw error;
    }
}
function isRegisteredWorktreePath(repoRoot, wtPath) {
    try {
        const output = git(repoRoot, ['worktree', 'list', '--porcelain']);
        const resolvedWtPath = resolve(wtPath);
        for (const line of output.split('\n')) {
            if (line.startsWith('worktree ')) {
                currentPath = resolve(line.slice('worktree '.length).trim());
                continue;
            if (resolve(line.slice('worktree '.length).trim()) === resolvedWtPath) {
                return true;
            }
        }
    }
    catch {
        // Best-effort check only.
    }
    return undefined;
}
function isWorktreeDirty(wtPath) {
    try {
        return git(wtPath, ['status', '--porcelain'], wtPath).length > 0;
    }
    catch {
        return false;
    }
}
function currentBranch(wtPath) {
    try {
        return git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD'], wtPath);
    }
    catch {
        return '';
    }
}
function isDetached(wtPath) {
    return currentBranch(wtPath) === 'HEAD';
}
function isRegisteredWorktreePath(repoRoot, wtPath) {
    return getRegisteredWorktreeBranch(repoRoot, wtPath) !== undefined;
}
function isWorktreeDirty(wtPath) {
    try {
        return gitOutput(wtPath, ['status', '--porcelain'], wtPath).trim() !== '';
    }
    catch {
        return existsSync(wtPath);
    }
}
/** Get worktree metadata path. */
function getMetadataPath(repoRoot, teamName) {
    return join(repoRoot, '.omc', 'state', 'team', sanitizeName(teamName), 'worktrees.json');
}
function getLegacyMetadataPath(repoRoot, teamName) {
    return join(repoRoot, '.omc', 'state', 'team-bridge', sanitizeName(teamName), 'worktrees.json');
}
/** Read worktree metadata, including legacy metadata for cleanup compatibility. */
function readMetadata(repoRoot, teamName) {
    const metaPath = getMetadataPath(repoRoot, teamName);
    if (!existsSync(metaPath))
        return [];
    try {
        return JSON.parse(readFileSync(metaPath, 'utf-8'));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[omc] warning: worktrees.json parse error: ${msg}\n`);
        return [];
    }
    return [...byWorker.values()];
}
/** Write native worktree metadata. */
function writeMetadata(repoRoot, teamName, entries) {
    const metaPath = getMetadataPath(repoRoot, teamName);
    validateResolvedPath(metaPath, repoRoot);
    ensureDirWithMode(join(repoRoot, '.omc', 'state', 'team', sanitizeName(teamName)));
    atomicWriteJson(metaPath, entries);
}
function recordMetadata(repoRoot, teamName, info) {
    const metaLockPath = getMetadataPath(repoRoot, teamName) + '.lock';
    withFileLockSync(metaLockPath, () => {
        const existing = readMetadata(repoRoot, teamName);
        const updated = existing.filter(e => e.workerName !== info.workerName);
        updated.push(info);
        writeMetadata(repoRoot, teamName, updated);
    });
}
function forgetMetadata(repoRoot, teamName, workerName) {
    const metaLockPath = getMetadataPath(repoRoot, teamName) + '.lock';
    withFileLockSync(metaLockPath, () => {
        const existing = readMetadata(repoRoot, teamName);
        const updated = existing.filter(e => e.workerName !== workerName);
        writeMetadata(repoRoot, teamName, updated);
    });
}
function assertCompatibleExistingWorktree(repoRoot, wtPath, branch, mode) {
    if (!isRegisteredWorktreePath(repoRoot, wtPath)) {
        const error = new Error(`worktree_path_mismatch: existing path is not a registered git worktree: ${wtPath}`);
        error.code = 'worktree_path_mismatch';
        throw error;
    }
    if (isWorktreeDirty(wtPath)) {
        const error = new Error(`worktree_dirty: preserving dirty worker worktree at ${wtPath}`);
        error.code = 'worktree_dirty';
        throw error;
    }
    const detached = isDetached(wtPath);
    if (mode === 'detached' && !detached) {
        const error = new Error(`worktree_mode_mismatch: expected detached worktree at ${wtPath}`);
        error.code = 'worktree_mode_mismatch';
        throw error;
    }
    if (mode === 'branch' && currentBranch(wtPath) !== branch) {
        const error = new Error(`worktree_branch_mismatch: expected ${branch} at ${wtPath}`);
        error.code = 'worktree_branch_mismatch';
        throw error;
    }
}
export function normalizeTeamWorktreeMode(value) {
    if (typeof value !== 'string')
        return 'disabled';
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled', 'detached'].includes(normalized))
        return 'detached';
    if (['branch', 'named', 'named-branch'].includes(normalized))
        return 'branch';
    return 'disabled';
}
/**
 * Ensure a worker worktree exists according to the selected opt-in mode.
 * Disabled mode is a no-op. Existing clean compatible worktrees are reused;
 * dirty or mismatched existing worktrees throw without deleting files.
 */
export function ensureWorkerWorktree(teamName, workerName, repoRoot, options = {}) {
    const mode = options.mode ?? 'disabled';
    if (mode === 'disabled')
        return null;
    if (!isInsideGitRepo(repoRoot)) {
        throw new Error(`not_a_git_repository: ${repoRoot}`);
    }
    if (options.requireCleanLeader !== false) {
        assertCleanLeaderWorktree(repoRoot);
    }
    const wtPath = getWorktreePath(repoRoot, teamName, workerName);
    const branch = mode === 'branch' ? getBranchName(teamName, workerName) : 'HEAD';
    validateResolvedPath(wtPath, repoRoot);
    try {
        execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe' });
    }
    catch { /* ignore */ }
    if (existsSync(wtPath)) {
        assertCompatibleExistingWorktree(repoRoot, wtPath, branch, mode);
        const info = {
            path: wtPath,
            branch,
            workerName,
            teamName,
            createdAt: new Date().toISOString(),
            repoRoot,
            mode,
            detached: isDetached(wtPath),
            created: false,
            reused: true,
        };
        recordMetadata(repoRoot, teamName, info);
        return info;
    }
    const wtDir = join(repoRoot, '.omc', 'team', sanitizeName(teamName), 'worktrees');
    ensureDirWithMode(wtDir);
    const args = mode === 'branch'
        ? ['worktree', 'add', '-b', branch, wtPath, options.baseRef ?? 'HEAD']
        : ['worktree', 'add', '--detach', wtPath, options.baseRef ?? 'HEAD'];
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    const info = {
        path: wtPath,
        branch,
        workerName,
        teamName,
        createdAt: new Date().toISOString(),
        repoRoot,
        mode,
        detached: mode === 'detached',
        created: true,
        reused: false,
    };
    recordMetadata(repoRoot, teamName, info);
    return info;
}
/** Legacy creation helper: create or reuse a branch-mode worker worktree. */
export function createWorkerWorktree(teamName, workerName, repoRoot, baseBranch) {
    const info = ensureWorkerWorktree(teamName, workerName, repoRoot, {
        mode: 'branch',
        baseRef: baseBranch,
        requireCleanLeader: false,
    });
    if (!info)
        throw new Error('worktree creation unexpectedly disabled');
    return info;
}
/** Remove a worker's worktree and branch, preserving dirty worktrees. */
export function removeWorkerWorktree(teamName, workerName, repoRoot) {
    const wtPath = getWorkerWorktreePath(repoRoot, teamName, workerName);
    const branch = getBranchName(teamName, workerName);
    if (existsSync(wtPath) && isWorktreeDirty(wtPath)) {
        const error = new Error(`worktree_dirty: preserving dirty worker worktree at ${wtPath}`);
        error.code = 'worktree_dirty';
        throw error;
    }
    try {
        execFileSync('git', ['worktree', 'remove', wtPath], { cwd: repoRoot, stdio: 'pipe' });
    }
    catch { /* may not exist */ }
    try {
        execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe' });
    }
    catch { /* ignore */ }
    try {
        execFileSync('git', ['branch', '-D', branch], { cwd: repoRoot, stdio: 'pipe' });
    }
    catch { /* branch may not exist */ }
    // If a stale plain directory remains and it is not a registered worktree, remove it.
    if (existsSync(wtPath) && !isRegisteredWorktreePath(repoRoot, wtPath)) {
        rmSync(wtPath, { recursive: true, force: true });
    }
    forgetMetadata(repoRoot, teamName, workerName);
}
/** List all worktrees for a team. */
export function listTeamWorktrees(teamName, repoRoot) {
    return readMetadata(repoRoot, teamName);
}
/** Remove all clean worktrees for a team, preserving dirty worktrees. */
export function cleanupTeamWorktrees(teamName, repoRoot) {
    const removed = [];
    const preserved = [];
    const entries = readMetadata(repoRoot, teamName);
    const removed = [];
    const preserved = [];
    for (const entry of entries) {
        try {
            removeWorkerWorktree(teamName, entry.workerName, repoRoot);
            removed.push(entry.workerName);
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            preserved.push({ workerName: entry.workerName, path: entry.path, reason });
            process.stderr.write(`[omc] warning: preserved worktree ${entry.path}: ${reason}\n`);
        }
    }
    return { removed, preserved };
}
//# sourceMappingURL=git-worktree.js.map