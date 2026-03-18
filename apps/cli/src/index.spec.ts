import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

describe('CLI Entry Point (index.ts)', () => {
  describe('program setup', () => {
    it('creates a Command with name "koda"', async () => {
      // Reload the module fresh
      const { program } = await import('./index');
      expect(program.name()).toBe('koda');
    });

    it('sets the correct description', async () => {
      const { program } = await import('./index');
      expect(program.description()).toContain('dev ticket tracker');
    });

    it('sets the version from package.json', async () => {
      const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));
      const { program } = await import('./index');
      const version = program.version();
      expect(version).toBe(packageJson.version);
    });

    it('exports a program instance', async () => {
      const indexModule = await import('./index');
      expect(indexModule.program).toBeDefined();
      expect(indexModule.program).toBeInstanceOf(Command);
    });
  });

  describe('shebang', () => {
    it('has shebang line in source file', () => {
      const sourceFile = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf-8');
      expect(sourceFile.startsWith('#!/usr/bin/env node')).toBe(true);
    });

    it('preserves shebang in compiled dist/index.js', () => {
      const distFile = path.join(__dirname, '../dist/index.js');
      if (fs.existsSync(distFile)) {
        const compiled = fs.readFileSync(distFile, 'utf-8');
        expect(compiled.startsWith('#!/usr/bin/env node')).toBe(true);
      }
    });
  });

  describe('command imports', () => {
    it('imports command modules without errors', async () => {
      // These imports should not throw
      expect(async () => {
        await import('./commands/login');
        await import('./commands/config');
        await import('./commands/project');
        await import('./commands/ticket');
        await import('./commands/comment');
        await import('./commands/agent');
        await import('./commands/version');
      }).not.toThrow();
    });

    it('command modules export functions', async () => {
      const loginMod = await import('./commands/login');
      const configMod = await import('./commands/config');
      const projectMod = await import('./commands/project');
      const ticketMod = await import('./commands/ticket');
      const commentMod = await import('./commands/comment');
      const agentMod = await import('./commands/agent');
      const versionMod = await import('./commands/version');

      expect(typeof loginMod.loginCommand).toBe('function');
      expect(typeof configMod.configCommand).toBe('function');
      expect(typeof projectMod.projectCommand).toBe('function');
      expect(typeof ticketMod.ticketCommand).toBe('function');
      expect(typeof commentMod.commentCommand).toBe('function');
      expect(typeof agentMod.agentCommand).toBe('function');
      expect(typeof versionMod.versionCommand).toBe('function');
    });
  });
});
