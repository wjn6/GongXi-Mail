import React from 'react';
import { Typography, Breadcrumb, Space } from 'antd';

const { Title, Text } = Typography;

interface PageHeaderProps {
    title: string;
    subtitle?: string;
    breadcrumb?: Array<{ title: string; path?: string }>;
    extra?: React.ReactNode;
}

const PageHeader: React.FC<PageHeaderProps> = ({
    title,
    subtitle,
    breadcrumb,
    extra,
}) => {
    return (
        <div style={{ marginBottom: 20 }}>
            {breadcrumb && breadcrumb.length > 0 && (
                <Breadcrumb
                    items={breadcrumb.map((item) => ({
                        title: item.path ? <a href={item.path}>{item.title}</a> : item.title,
                    }))}
                    style={{ marginBottom: 8 }}
                />
            )}
            <div className="gx-page-head" style={{ marginBottom: 0 }}>
                <div style={{ minWidth: 0 }}>
                    <Title level={4} style={{ marginBottom: 0 }}>{title}</Title>
                    {subtitle && <Text type="secondary">{subtitle}</Text>}
                </div>
                {extra && <Space wrap>{extra}</Space>}
            </div>
        </div>
    );
};

export default PageHeader;
