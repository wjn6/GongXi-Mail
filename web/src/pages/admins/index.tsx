import React, { useCallback, useEffect, useState } from 'react';
import {
    Table,
    Button,
    Space,
    Modal,
    Form,
    Input,
    Select,
    message,
    Popconfirm,
    Tag,
    Typography,
    Tooltip,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { adminApi } from '../../api';
import { useAuthStore } from '../../stores/authStore';
import { getAdminRoleLabel, getAdminStatusLabel, isSuperAdmin, normalizeAdminStatus } from '../../utils/auth';
import { getErrorMessage } from '../../utils/error';
import { requestData } from '../../utils/request';
import dayjs from 'dayjs';

const { Title } = Typography;

interface Admin {
    id: number;
    username: string;
    email: string | null;
    role: 'SUPER_ADMIN' | 'ADMIN';
    status: 'ACTIVE' | 'DISABLED';
    lastLoginAt: string | null;
    lastLoginIp: string | null;
    createdAt: string;
}

interface AdminListResult {
    list: Admin[];
    total: number;
}

const AdminsPage: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<Admin[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [modalVisible, setModalVisible] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [form] = Form.useForm();
    const { admin: currentAdmin } = useAuthStore();

    const fetchData = useCallback(async () => {
        setLoading(true);
        const result = await requestData<AdminListResult>(
            () => adminApi.getList({ page, pageSize }),
            '获取数据失败'
        );
        if (result) {
            setData(result.list);
            setTotal(result.total);
        }
        setLoading(false);
    }, [page, pageSize]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void fetchData();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [fetchData]);

    const handleCreate = () => {
        setEditingId(null);
        form.resetFields();
        setModalVisible(true);
    };

    const handleEdit = (record: Admin) => {
        setEditingId(record.id);
        form.setFieldsValue({
            username: record.username,
            email: record.email,
            role: record.role,
            status: record.status,
            password: '',
        });
        setModalVisible(true);
    };

    const handleDelete = async (id: number) => {
        try {
            const res = await adminApi.delete(id);
            if (res.code === 200) {
                message.success('删除成功');
                fetchData();
            } else {
                message.error(res.message);
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '删除失败'));
        }
    };

    const handleSubmit = async () => {
        try {
            const values = await form.validateFields();

            if (editingId) {
                // 如果密码为空，不更新密码
                if (!values.password) {
                    delete values.password;
                }
                const res = await adminApi.update(editingId, values);
                if (res.code === 200) {
                    message.success('更新成功');
                    setModalVisible(false);
                    fetchData();
                } else {
                    message.error(res.message);
                }
            } else {
                const res = await adminApi.create(values);
                if (res.code === 200) {
                    message.success('创建成功');
                    setModalVisible(false);
                    fetchData();
                } else {
                    message.error(res.message);
                }
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '保存失败'));
        }
    };

    const columns: ColumnsType<Admin> = [
        {
            title: '用户名',
            dataIndex: 'username',
            key: 'username',
        },
        {
            title: '邮箱',
            dataIndex: 'email',
            key: 'email',
            render: (val) => val || '-',
        },
        {
            title: '角色',
            dataIndex: 'role',
            key: 'role',
            render: (role) => (
                <Tag color={isSuperAdmin(role) ? 'gold' : 'blue'}>
                    {getAdminRoleLabel(role)}
                </Tag>
            ),
        },
        {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            render: (status) => (
                <Tag color={normalizeAdminStatus(status) === 'ACTIVE' ? 'green' : 'red'}>
                    {getAdminStatusLabel(status)}
                </Tag>
            ),
        },
        {
            title: '最后登录',
            dataIndex: 'lastLoginAt',
            key: 'lastLoginAt',
            render: (val, record) =>
                val ? (
                    <Tooltip title={`IP: ${record.lastLoginIp || '未知'}`}>
                        {dayjs(val).format('YYYY-MM-DD HH:mm')}
                    </Tooltip>
                ) : (
                    '-'
                ),
        },
        {
            title: '创建时间',
            dataIndex: 'createdAt',
            key: 'createdAt',
            render: (val) => dayjs(val).format('YYYY-MM-DD HH:mm'),
        },
        {
            title: '操作',
            key: 'action',
            width: 120,
            render: (_, record) => (
                <Space>
                    <Tooltip title="编辑">
                        <Button
                            type="text"
                            icon={<EditOutlined />}
                            onClick={() => handleEdit(record)}
                        />
                    </Tooltip>
                    {record.id !== currentAdmin?.id && (
                        <Tooltip title="删除">
                            <Popconfirm
                                title="确定要删除此管理员吗？"
                                onConfirm={() => handleDelete(record.id)}
                            >
                                <Button type="text" danger icon={<DeleteOutlined />} />
                            </Popconfirm>
                        </Tooltip>
                    )}
                </Space>
            ),
        },
    ];

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <Title level={4} style={{ margin: 0 }}>
                    管理员管理
                </Title>
                <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
                    添加管理员
                </Button>
            </div>

            <Table
                columns={columns}
                dataSource={data}
                rowKey="id"
                loading={loading}
                pagination={{
                    current: page,
                    pageSize,
                    total,
                    showSizeChanger: true,
                    showTotal: (total) => `共 ${total} 条`,
                    onChange: (p, ps) => {
                        setPage(p);
                        setPageSize(ps);
                    },
                }}
            />

            <Modal
                title={editingId ? '编辑管理员' : '添加管理员'}
                open={modalVisible}
                onOk={handleSubmit}
                onCancel={() => setModalVisible(false)}
            >
                <Form form={form} layout="vertical">
                    <Form.Item
                        name="username"
                        label="用户名"
                        rules={[
                            { required: true, message: '请输入用户名' },
                            { min: 3, message: '用户名至少 3 个字符' },
                        ]}
                    >
                        <Input placeholder="请输入用户名" />
                    </Form.Item>
                    <Form.Item
                        name="password"
                        label="密码"
                        rules={
                            editingId
                                ? []
                                : [
                                    { required: true, message: '请输入密码' },
                                    { min: 6, message: '密码至少 6 个字符' },
                                ]
                        }
                    >
                        <Input.Password
                            placeholder={editingId ? '留空则不修改密码' : '请输入密码'}
                        />
                    </Form.Item>
                    <Form.Item name="email" label="邮箱">
                        <Input placeholder="可选" type="email" />
                    </Form.Item>
                    <Form.Item name="role" label="角色" initialValue="ADMIN">
                        <Select>
                            <Select.Option value="ADMIN">管理员</Select.Option>
                            <Select.Option value="SUPER_ADMIN">超级管理员</Select.Option>
                        </Select>
                    </Form.Item>
                    <Form.Item name="status" label="状态" initialValue="ACTIVE">
                        <Select>
                            <Select.Option value="ACTIVE">启用</Select.Option>
                            <Select.Option value="DISABLED">禁用</Select.Option>
                        </Select>
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    );
};

export default AdminsPage;
