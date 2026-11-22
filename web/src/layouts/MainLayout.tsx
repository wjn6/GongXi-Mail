import React, { useEffect, useMemo, useState } from 'react';
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import {
    Layout,
    Menu,
    Avatar,
    Dropdown,
    Drawer,
    theme,
    Typography,
    Space,
    Breadcrumb,
    Button,
} from 'antd';
import type { MenuProps } from 'antd';
import {
    DashboardOutlined,
    UserOutlined,
    KeyOutlined,
    MailOutlined,
    SettingOutlined,
    LogoutOutlined,
    MenuFoldOutlined,
    MenuUnfoldOutlined,
    MenuOutlined,
    FileTextOutlined,
    HistoryOutlined,
    FileSearchOutlined,
} from '@ant-design/icons';
import { useAuthStore } from '../stores/authStore';
import { authApi } from '../api';
import { isSuperAdmin } from '../utils/auth';
import { useIsMobile } from '../hooks/useIsMobile';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

const SIDER_WIDTH = 208;
const SIDER_COLLAPSED_WIDTH = 80;
const HEADER_HEIGHT = 56;
const COLLAPSED_STORAGE_KEY = 'gx.sider.collapsed';
const APP_NAME = '廾匸邮箱';

const menuConfig = [
    { key: '/dashboard', icon: <DashboardOutlined />, label: '数据概览', title: '数据概览' },
    { key: '/emails', icon: <MailOutlined />, label: '邮箱管理', title: '邮箱管理' },
    { key: '/api-keys', icon: <KeyOutlined />, label: 'API Key', title: 'API Key 管理' },
    { key: '/api-docs', icon: <FileTextOutlined />, label: 'API 文档', title: 'API 文档' },
    { key: '/operation-logs', icon: <HistoryOutlined />, label: '操作日志', title: '操作日志' },
    { key: '/system-logs', icon: <FileSearchOutlined />, label: '系统日志', title: '系统日志' },
    { key: '/admins', icon: <UserOutlined />, label: '管理员', title: '管理员管理', superAdmin: true },
    { key: '/settings', icon: <SettingOutlined />, label: '系统设置', title: '系统设置' },
];

const readCollapsed = (): boolean => {
    try {
        return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
};

const Logo: React.FC<{ showText: boolean; primary: string }> = ({ showText, primary }) => (
    <Space>
        <div
            style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: `linear-gradient(135deg, ${primary}, #722ed1)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontWeight: 600,
                flexShrink: 0,
            }}
        >
            GX
        </div>
        {showText && <Text strong style={{ fontSize: 16, whiteSpace: 'nowrap' }}>{APP_NAME}</Text>}
    </Space>
);

const MainLayout: React.FC = () => {
    const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const navigate = useNavigate();
    const location = useLocation();
    const { admin, clearAuth } = useAuthStore();
    const { token } = theme.useToken();
    const isMobile = useIsMobile();

    const hasSuperAdminPermission = isSuperAdmin(admin?.role);
    const displayName = admin?.username?.trim() || 'Admin';
    const avatarText = displayName.charAt(0).toUpperCase();

    const menuItems: MenuProps['items'] = useMemo(
        () =>
            menuConfig
                .filter(item => !item.superAdmin || hasSuperAdminPermission)
                .map(item => ({
                    key: item.key,
                    icon: item.icon,
                    label: <Link to={item.key}>{item.label}</Link>,
                })),
        [hasSuperAdminPermission]
    );

    const currentMenu = menuConfig.find(item => location.pathname.startsWith(item.key));
    const pageTitle = currentMenu?.title || '管理后台';
    const selectedKeys = currentMenu ? [currentMenu.key] : [];

    useEffect(() => {
        document.title = `${pageTitle} - ${APP_NAME}`;
    }, [pageTitle]);

    useEffect(() => {
        try {
            window.localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
        } catch {
            // ignore storage errors (private mode etc.)
        }
    }, [collapsed]);

    const handleLogout = async () => {
        try {
            await authApi.logout();
        } catch {
            // ignore
        }
        clearAuth();
        navigate('/login');
    };

    const userMenuItems: MenuProps['items'] = [
        {
            key: 'user',
            label: (
                <div style={{ minWidth: 140 }}>
                    <Text strong>{displayName}</Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                        {hasSuperAdminPermission ? '超级管理员' : '管理员'}
                    </Text>
                </div>
            ),
            disabled: true,
        },
        { type: 'divider' },
        {
            key: 'profile',
            icon: <UserOutlined />,
            label: '个人设置',
            onClick: () => navigate('/settings'),
        },
        { type: 'divider' },
        {
            key: 'logout',
            icon: <LogoutOutlined />,
            label: '退出登录',
            danger: true,
            onClick: handleLogout,
        },
    ];

    const navMenu = (
        <Menu
            theme="light"
            mode="inline"
            selectedKeys={selectedKeys}
            items={menuItems}
            onClick={() => setDrawerOpen(false)}
            style={{ borderInlineEnd: 0, marginTop: 8 }}
        />
    );

    const siderOffset = isMobile ? 0 : collapsed ? SIDER_COLLAPSED_WIDTH : SIDER_WIDTH;

    return (
        <Layout style={{ minHeight: '100vh' }}>
            {isMobile ? (
                <Drawer
                    open={drawerOpen}
                    placement="left"
                    size={240}
                    onClose={() => setDrawerOpen(false)}
                    closable={false}
                    styles={{ body: { padding: 0 } }}
                    title={<Logo showText primary={token.colorPrimary} />}
                >
                    {navMenu}
                </Drawer>
            ) : (
                <Sider
                    trigger={null}
                    collapsible
                    collapsed={collapsed}
                    theme="light"
                    width={SIDER_WIDTH}
                    collapsedWidth={SIDER_COLLAPSED_WIDTH}
                    style={{
                        overflow: 'auto',
                        height: '100vh',
                        position: 'fixed',
                        insetInlineStart: 0,
                        top: 0,
                        bottom: 0,
                        zIndex: 20,
                        borderInlineEnd: `1px solid ${token.colorBorderSecondary}`,
                    }}
                >
                    <div
                        style={{
                            height: HEADER_HEIGHT,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderBottom: `1px solid ${token.colorBorderSecondary}`,
                        }}
                    >
                        <Logo showText={!collapsed} primary={token.colorPrimary} />
                    </div>
                    {navMenu}
                </Sider>
            )}

            <Layout style={{ marginInlineStart: siderOffset, transition: 'margin 0.2s ease' }}>
                <Header
                    style={{
                        position: 'sticky',
                        top: 0,
                        zIndex: 10,
                        padding: isMobile ? '0 8px' : '0 24px',
                        background: 'rgba(255, 255, 255, 0.92)',
                        backdropFilter: 'saturate(180%) blur(8px)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        borderBottom: `1px solid ${token.colorBorderSecondary}`,
                        height: HEADER_HEIGHT,
                        lineHeight: `${HEADER_HEIGHT}px`,
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 4 : 12, minWidth: 0 }}>
                        <Button
                            type="text"
                            aria-label={isMobile ? '打开菜单' : collapsed ? '展开侧边栏' : '收起侧边栏'}
                            icon={isMobile ? <MenuOutlined /> : collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                            onClick={() => (isMobile ? setDrawerOpen(true) : setCollapsed(!collapsed))}
                        />
                        {isMobile ? (
                            <Text strong ellipsis style={{ fontSize: 16 }}>{pageTitle}</Text>
                        ) : (
                            <Breadcrumb items={[{ title: <Link to="/dashboard">首页</Link> }, { title: pageTitle }]} />
                        )}
                    </div>

                    <Dropdown menu={{ items: userMenuItems }} placement="bottomRight" trigger={['click']}>
                        <Button type="text" style={{ height: 40, paddingInline: isMobile ? 4 : 8 }}>
                            <Space size={8}>
                                <Avatar size="small" style={{ backgroundColor: token.colorPrimary }}>
                                    {avatarText}
                                </Avatar>
                                {!isMobile && <Text>{displayName}</Text>}
                            </Space>
                        </Button>
                    </Dropdown>
                </Header>

                <Content
                    style={{
                        margin: isMobile ? 8 : 24,
                        padding: isMobile ? 12 : 24,
                        background: token.colorBgContainer,
                        borderRadius: token.borderRadiusLG,
                        minHeight: `calc(100vh - ${HEADER_HEIGHT}px - ${isMobile ? 16 : 48}px)`,
                        minWidth: 0,
                    }}
                >
                    <Outlet />
                </Content>
            </Layout>
        </Layout>
    );
};

export default MainLayout;
