import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  createWorkerWorktree,
  removeWorkerWorktree,
  listTeamWorktrees,
  cleanupTeamWorktrees,
} from '../git-worktree.js';

describe('git-worktree', () => {
  let repoDir: string;
  const teamName = 'test-wt';

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'git-worktree-test-'));
    // Initialize a git repo with an initial commit
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'README.md'), '# Test\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir, stdio: 'pipe' });
  });

  afterEach(() => {
    // Clean up worktrees first (git needs this before rmSync)
    try {
      cleanupTeamWorktrees(teamName, repoDir);
    } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe('createWorkerWorktree', () => {
    it('creates worktree at correct path', () => {
      const info = createWorkerWorktree(teamName, 'worker1', repoDir);

      expect(info.path).toContain('.omc/team/test-wt/worktrees');
      expect(info.created).toBe(true);
      expect(info.reused).toBe(false);
      expect(info.branch).toBe(`omc-team/${teamName}/worker1`);
      expect(info.workerName).toBe('worker1');
      expect(info.teamName).toBe(teamName);
      expect(existsSync(info.path)).toBe(true);
    });

    it('branch name is properly sanitized', () => {
      const info = createWorkerWorktree(teamName, 'worker-with-special', repoDir);
      expect(info.branch).toContain('omc-team/');
      expect(existsSync(info.path)).toBe(true);
    });

    it('handles recreation of stale worktree', () => {
      const info1 = createWorkerWorktree(teamName, 'worker1', repoDir);
      expect(existsSync(info1.path)).toBe(true);

      // Recreate the same worktree
      const info2 = createWorkerWorktree(teamName, 'worker1', repoDir);
      expect(existsSync(info2.path)).toBe(true);
      expect(info2.path).toBe(info1.path);
      expect(info2.created).toBe(false);
      expect(info2.reused).toBe(true);
    });

    it('cleans up a stale plain directory before creating the worktree', () => {
      const stalePath = join(repoDir, '.omc', 'team', teamName, 'worktrees', 'worker-stale');
      // Create a directory that is not registered as a git worktree.
      rmSync(stalePath, { recursive: true, force: true });
      mkdirSync(stalePath, { recursive: true });
      writeFileSync(join(stalePath, 'orphan.txt'), 'orphaned state');

      const info = createWorkerWorktree(teamName, 'worker-stale', repoDir);

      expect(info.path).toBe(stalePath);
      expect(existsSync(join(stalePath, 'orphan.txt'))).toBe(false);
      expect(existsSync(info.path)).toBe(true);
    });
  });

  describe('removeWorkerWorktree', () => {
    it('preserves dirty worktrees instead of force-removing them', () => {
      const info = createWorkerWorktree(teamName, 'dirty-worker', repoDir);
      writeFileSync(join(info.path, 'dirty.txt'), 'dirty');

      expect(() => removeWorkerWorktree(teamName, 'dirty-worker', repoDir)).toThrow(/worktree_dirty/);
      expect(existsSync(info.path)).toBe(true);
    });

    it('removes worktree and branch', () => {
      const info = createWorkerWorktree(teamName, 'worker1', repoDir);
      expect(existsSync(info.path)).toBe(true);

      removeWorkerWorktree(teamName, 'worker1', repoDir);

      // Worktree directory should be gone
      expect(existsSync(info.path)).toBe(false);

      // Branch should be deleted
      const branches = execFileSync('git', ['branch'], { cwd: repoDir, encoding: 'utf-8' });
      expect(branches).not.toContain('omc-team/');
    });

    it('does not throw for non-existent worktree', () => {
      expect(() => removeWorkerWorktree(teamName, 'nonexistent', repoDir)).not.toThrow();
    });
  });

  describe('listTeamWorktrees', () => {
    it('returns empty for team with no worktrees', () => {
      const list = listTeamWorktrees(teamName, repoDir);
      expect(list).toEqual([]);
    });

    it('lists created worktrees', () => {
      createWorkerWorktree(teamName, 'worker1', repoDir);
      createWorkerWorktree(teamName, 'worker2', repoDir);

      const list = listTeamWorktrees(teamName, repoDir);
      expect(list).toHaveLength(2);
      expect(list.map(w => w.workerName)).toContain('worker1');
      expect(list.map(w => w.workerName)).toContain('worker2');
    });
  });

  describe('cleanupTeamWorktrees', () => {
    it('removes all worktrees for a team', () => {
      createWorkerWorktree(teamName, 'worker1', repoDir);
      createWorkerWorktree(teamName, 'worker2', repoDir);

      expect(listTeamWorktrees(teamName, repoDir)).toHaveLength(2);

      const result = cleanupTeamWorktrees(teamName, repoDir);

      expect(result.preserved).toHaveLength(0);
      expect(listTeamWorktrees(teamName, repoDir)).toHaveLength(0);
    });

    it('preserves dirty worktrees during cleanup and leaves metadata for follow-up', () => {
      const dirty = createWorkerWorktree(teamName, 'worker-dirty', repoDir);
      writeFileSync(join(dirty.path, 'dirty.txt'), 'dirty');

      const result = cleanupTeamWorktrees(teamName, repoDir);

      expect(result.removed).toHaveLength(0);
      expect(result.preserved).toHaveLength(1);
      expect(existsSync(dirty.path)).toBe(true);
      expect(listTeamWorktrees(teamName, repoDir)).toHaveLength(1);
    });
  });
});
