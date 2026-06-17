// Re-export shim — the implementation lives in the shared print cluster so
// pay-slip / agreement print routes can reuse it. The invoicing route is
// unchanged (still imports `{ AutoPrint }` from this path).
export { AutoPrint } from '@/components/print/AutoPrint';
