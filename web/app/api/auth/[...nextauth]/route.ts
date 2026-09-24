// @api-envelope-exempt: NextAuth 自己的端點，回應形狀由 Auth.js 決定（OAuth 流程、
// CSRF token、session cookie）。它不是本站的 API，不能也不該套我們的信封。
import { handlers } from "@/auth";
export const { GET, POST } = handlers;
