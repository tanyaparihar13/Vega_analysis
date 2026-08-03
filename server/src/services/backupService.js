'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
require('dotenv').config();

const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
const FILENAME_RE = /^backup-[\w-]+\.sql$/;

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Runs mysqldump via execFile (array args, never a shell string — no
 * shell-injection surface) and writes straight to a timestamped .sql file.
 * The DB password goes through the MYSQL_PWD env var rather than a CLI flag,
 * since a `-p<password>` argument is visible to anything that can list this
 * machine's processes.
 */
function createBackup() {
  ensureBackupDir();

  const mysqldumpPath = process.env.MYSQLDUMP_PATH || 'mysqldump';
  const filename = `backup-${timestampSlug()}.sql`;
  const outPath = path.join(BACKUP_DIR, filename);

  const args = [
    '-h', process.env.DB_HOST || 'localhost',
    '-P', String(Number(process.env.DB_PORT) || 3306),
    '-u', process.env.DB_USER,
    process.env.DB_NAME,
  ];

  return new Promise((resolve, reject) => {
    const child = execFile(
      mysqldumpPath,
      args,
      {
        env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD || '' },
        maxBuffer: 1024 * 1024 * 1024, // 1GB ceiling on stdout buffering
      },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') {
            return reject(new Error(
              `mysqldump not found ('${mysqldumpPath}'). Set MYSQLDUMP_PATH in server/.env to the full path of mysqldump.exe.`
            ));
          }
          return reject(new Error(`mysqldump failed: ${stderr || err.message}`));
        }
        try {
          fs.writeFileSync(outPath, stdout, 'utf8');
        } catch (writeErr) {
          return reject(writeErr);
        }
        const stats = fs.statSync(outPath);
        resolve({ filename, size: stats.size, createdAt: stats.mtime });
      }
    );
    // mysqldump writes the dump to stdout; execFile's callback already buffers it via maxBuffer.
    void child;
  });
}

function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => FILENAME_RE.test(f))
    .map((f) => {
      const stats = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, size: stats.size, createdAt: stats.mtime };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Validates the filename against a strict pattern before building a path, blocking path traversal. */
function resolveBackupPath(filename) {
  if (!FILENAME_RE.test(String(filename || ''))) {
    throw new Error('Invalid backup filename');
  }
  const fullPath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    throw new Error('Backup not found');
  }
  return fullPath;
}

module.exports = { createBackup, listBackups, resolveBackupPath, BACKUP_DIR };
