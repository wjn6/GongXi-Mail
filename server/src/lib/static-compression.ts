import { brotliCompressSync, constants, gzipSync } from 'zlib';
import { promises as fs } from 'fs';
import { extname, join } from 'path';

const COMPRESSIBLE_EXTENSIONS = new Set([
    '.js',
    '.css',
    '.html',
    '.svg',
    '.json',
    '.txt',
    '.xml',
    '.map',
    '.woff2',
]);

const MIN_COMPRESS_SIZE_BYTES = 1024;

async function pathExists(path: string): Promise<boolean> {
    try {
        await fs.access(path);
        return true;
    } catch {
        return false;
    }
}

async function listFilesRecursively(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await listFilesRecursively(fullPath));
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }

    return files;
}

function shouldCompressFile(filePath: string): boolean {
    if (filePath.endsWith('.gz') || filePath.endsWith('.br')) {
        return false;
    }
    return COMPRESSIBLE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

async function shouldRegenerate(sourcePath: string, compressedPath: string): Promise<boolean> {
    if (!await pathExists(compressedPath)) {
        return true;
    }

    const [sourceStat, compressedStat] = await Promise.all([
        fs.stat(sourcePath),
        fs.stat(compressedPath),
    ]);

    return sourceStat.mtimeMs > compressedStat.mtimeMs;
}

async function compressFileVariants(filePath: string): Promise<number> {
    const source = await fs.readFile(filePath);
    if (source.byteLength < MIN_COMPRESS_SIZE_BYTES) {
        return 0;
    }

    let generated = 0;
    const gzipPath = `${filePath}.gz`;
    const brotliPath = `${filePath}.br`;

    if (await shouldRegenerate(filePath, gzipPath)) {
        const gzipBuffer = gzipSync(source, {
            level: constants.Z_BEST_COMPRESSION,
        });
        if (gzipBuffer.byteLength < source.byteLength) {
            await fs.writeFile(gzipPath, gzipBuffer);
            generated++;
        }
    }

    if (await shouldRegenerate(filePath, brotliPath)) {
        const brotliBuffer = brotliCompressSync(source, {
            params: {
                [constants.BROTLI_PARAM_QUALITY]: 11,
            },
        });
        if (brotliBuffer.byteLength < source.byteLength) {
            await fs.writeFile(brotliPath, brotliBuffer);
            generated++;
        }
    }

    return generated;
}

export async function ensurePrecompressedAssets(rootDir: string): Promise<{ files: number; generated: number }> {
    if (!await pathExists(rootDir)) {
        return { files: 0, generated: 0 };
    }

    const allFiles = await listFilesRecursively(rootDir);
    const targets = allFiles.filter(shouldCompressFile);

    let generated = 0;
    for (const filePath of targets) {
        generated += await compressFileVariants(filePath);
    }

    return {
        files: targets.length,
        generated,
    };
}
