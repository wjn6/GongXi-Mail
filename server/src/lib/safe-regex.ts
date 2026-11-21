const MAX_PATTERN_LENGTH = 200;
const MAX_STAR_HEIGHT = 1;
const MAX_REPETITIONS = 25;

interface PatternStats {
    starHeight: number;
    repetitions: number;
}

/**
 * 粗粒度静态检查（safe-regex 思路）：限制长度、拒绝回溯引用与环视、
 * 限制星型嵌套高度和总量词数，阻断用户自定义正则的灾难性回溯（ReDoS）。
 * 这是启发式检查，不是完备证明；正则语法合法性仍由调用方的 new RegExp 兜底。
 */
export function isSafeUserRegex(source: string): boolean {
    if (typeof source !== 'string' || source.length === 0 || source.length > MAX_PATTERN_LENGTH) {
        return false;
    }

    if (/\\[1-9]/.test(source)) {
        return false;
    }

    if (/\(\?<?[=!]/.test(source)) {
        return false;
    }

    const stats = scanPattern(source);
    return stats.starHeight <= MAX_STAR_HEIGHT && stats.repetitions <= MAX_REPETITIONS;
}

function scanPattern(source: string): PatternStats {
    // 栈顶是当前组内容的最大量词高度；出栈时作为该组原子的层级带回，
    // 量词的高度 = 所修饰原子的层级 + 1，从而只拒绝“重复的重复”
    const groupStack: number[] = [];
    let maxStarHeight = 0;
    let repetitions = 0;
    let lastAtomHeight = 0;
    let inClass = false;
    let i = 0;

    const applyQuantifier = () => {
        const qHeight = lastAtomHeight + 1;
        maxStarHeight = Math.max(maxStarHeight, qHeight);
        repetitions += 1;
        lastAtomHeight = qHeight;
        if (groupStack.length > 0) {
            const top = groupStack.length - 1;
            groupStack[top] = Math.max(groupStack[top], qHeight);
        }
    };

    while (i < source.length) {
        const ch = source[i];

        if (ch === '\\') {
            lastAtomHeight = 0;
            i += 2;
            continue;
        }

        if (inClass) {
            if (ch === ']') {
                inClass = false;
                lastAtomHeight = 0;
            }
            i += 1;
            continue;
        }

        if (ch === '[') {
            inClass = true;
            lastAtomHeight = 0;
            i += 1;
            continue;
        }

        if (ch === '(') {
            // (?:...) 非捕获组与 (?<name>...) 命名组：跳过组头，避免把 ? 当量词
            if (source[i + 1] === '?') {
                if (source[i + 2] === ':') {
                    groupStack.push(0);
                    i += 3;
                    continue;
                }
                if (source[i + 2] === '<') {
                    const close = source.indexOf('>', i + 3);
                    if (close > i + 3) {
                        groupStack.push(0);
                        i = close + 1;
                        continue;
                    }
                }
                // 其余 (? 开头（环视等）已在入口被拒绝；兜底按普通组处理
            }
            groupStack.push(0);
            i += 1;
            continue;
        }

        if (ch === ')') {
            const groupHeight = groupStack.pop() ?? 0;
            lastAtomHeight = groupHeight;
            if (groupStack.length > 0) {
                const top = groupStack.length - 1;
                groupStack[top] = Math.max(groupStack[top], groupHeight);
            }
            i += 1;
            continue;
        }

        if (ch === '|') {
            lastAtomHeight = 0;
            i += 1;
            continue;
        }

        if (ch === '*' || ch === '+') {
            applyQuantifier();
            i += 1;
            continue;
        }

        if (ch === '?') {
            const prev = i > 0 ? source[i - 1] : '';
            if (prev === '*' || prev === '+' || prev === '?') {
                i += 1;
                continue;
            }
            applyQuantifier();
            i += 1;
            continue;
        }

        if (ch === '{') {
            const close = source.indexOf('}', i + 1);
            if (close > i && /^\d+(,\d*)?$/.test(source.slice(i + 1, close)) && isQuantifierPosition(source, i)) {
                applyQuantifier();
                i = close + 1;
                if (source[i] === '?') {
                    i += 1;
                }
                continue;
            }
            lastAtomHeight = 0;
            i += 1;
            continue;
        }

        lastAtomHeight = 0;
        i += 1;
    }

    return { starHeight: maxStarHeight, repetitions };
}

function isQuantifierPosition(source: string, index: number): boolean {
    const prev = index > 0 ? source[index - 1] : '';
    return prev !== '' && !'|('.includes(prev);
}
