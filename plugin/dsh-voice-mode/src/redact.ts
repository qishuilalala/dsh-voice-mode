/**
 * 错误详情脱敏（纯函数单一真源已收敛至 `@voice-mode/core`，此处保留宿主/客户端重导出）。
 *
 * 先在宽窗口上脱敏再截断，遮蔽鉴权头（Bearer / Basic / api-key）、URL 凭据与查询参数、
 * JSON 密钥字段、常见厂商前缀（sk-/gsk_/AIza/ghp_）及混合大小写长随机串/32位十六进制密钥，
 * 同时保留模型名、UUID、文件路径与 64 位 SHA256 哈希供排障。
 */
export { redactBodySnippet, redactSecrets } from '@voice-mode/core'
