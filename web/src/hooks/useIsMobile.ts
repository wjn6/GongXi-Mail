import { useSyncExternalStore } from 'react';

/** 与 antd `md` 断点对齐：< 768px 视为手机端 */
export const MOBILE_MEDIA_QUERY = '(max-width: 767.98px)';

const getMediaQueryList = (): MediaQueryList | null =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(MOBILE_MEDIA_QUERY)
        : null;

const subscribe = (onChange: () => void) => {
    const mql = getMediaQueryList();
    if (!mql) {
        return () => {};
    }
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
};

const getSnapshot = () => getMediaQueryList()?.matches ?? false;

const getServerSnapshot = () => false;

/**
 * 同步读取当前是否为手机端宽度。
 * 与 Grid.useBreakpoint 不同，首帧即为正确值，避免桌面端闪现移动布局。
 */
export function useIsMobile(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
