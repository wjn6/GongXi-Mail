import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/admin': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return
          }
          if (id.includes('@ant-design/charts')) {
            return 'charts-wrapper-vendor'
          }
          if (id.includes('@antv/g2plot')) {
            return 'antv-g2plot-vendor'
          }
          if (id.includes('@antv/g2')) {
            return 'antv-g2-vendor'
          }
          if (id.includes('@antv/')) {
            return 'antv-core-vendor'
          }
          if (id.includes('@ant-design/icons')) {
            return 'antd-icons-vendor'
          }
          if (id.includes('antd/es/table') || id.includes('rc-table')) {
            return 'antd-table-vendor'
          }
          if (id.includes('antd/es/form') || id.includes('rc-field-form')) {
            return 'antd-form-vendor'
          }
          if (id.includes('antd/es/select') || id.includes('rc-select')) {
            return 'antd-select-vendor'
          }
          if (id.includes('antd/es/date-picker') || id.includes('rc-picker')) {
            return 'antd-date-vendor'
          }
          if (id.includes('antd/es/modal') || id.includes('rc-dialog')) {
            return 'antd-modal-vendor'
          }
          if (id.includes('antd')) {
            return 'antd-core-vendor'
          }
          if (id.includes('react') || id.includes('scheduler')) {
            return 'react-vendor'
          }
          if (id.includes('react-router-dom') || id.includes('react-router')) {
            return 'router-vendor'
          }
          if (id.includes('axios') || id.includes('zustand') || id.includes('dayjs')) {
            return 'utils-vendor'
          }
        },
      },
    },
  },
})
