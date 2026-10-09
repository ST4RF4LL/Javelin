import { type RouteConfig, index, layout, route } from '@react-router/dev/routes';
export default [layout('components/shell.tsx', [
  index('routes/dashboard.tsx'), route('audits', 'routes/audits.tsx'), route('audits/coverage', 'routes/file-coverage.tsx'), route('audits/:id', 'routes/audit-detail.tsx'),
  route('findings', 'routes/findings.tsx'), route('products', 'routes/products.tsx'), route('reports', 'routes/reports.tsx'),
  route('settings', 'routes/settings.tsx'),
  route('validation', 'routes/validation.tsx'), route('runtime', 'routes/runtime.tsx'), route('*', 'routes/not-found.tsx'),
])] satisfies RouteConfig;
