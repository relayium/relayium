// 上传有效期选项的档位过滤。
//
// 服务端 (server/internal/account/files.go 和 uploads_resumable.go) 对超出档位
// 留存上限的 TTL 是**静默截断**——不返回错误，也不在响应里说明。所以界面这边
// 必须保证永远不提供一个会被打折的选项，否则用户看到的承诺和实际拿到的保留
// 时间不一致，而且没有任何提示。
//
// 这在 2026-07 改价后尤其要紧：免费档从 3 天降到 1 天，选「7 天」实际只得 1 天。

/** 界面提供的固定四挡（秒）。顺序即渲染顺序，从短到长。 */
export const TTL_CHOICES = [3600, 86400, 259200, 604800] as const;

/**
 * 给定档位的留存上限（秒，0 = 不限），返回可以安全提供的选项。
 *
 * 上限为 0（无限档）时原样返回四挡——不会因为「无限」就凭空多出选项。
 */
export function allowedTtls(retentionCapSecs: number): number[] {
  if (!(retentionCapSecs > 0)) return [...TTL_CHOICES];
  const fits = TTL_CHOICES.filter((secs) => secs <= retentionCapSecs);
  // 上限小于最短选项时没有任何一挡合规。这时宁可保留最短的一个（服务端仍会
  // 截断它），也不能返回空列表——那会渲染出一个无法选择的下拉框，直接挡住上传。
  return fits.length > 0 ? fits : [TTL_CHOICES[0]];
}

/**
 * 把已选中的 TTL 收敛到 allowed 之内，返回仍然合法的那个值。
 *
 * 必须和 allowedTtls 成对使用：只过滤 <option> 而不动绑定值的话，已选中的值会
 * 停在一个不再渲染的选项上——下拉框显示空白，提交的却仍是那个会被截断的值。
 * 越界时取**最长的合法选项**，因为用户选长有效期的意图是明确的，给他们档位内
 * 能拿到的最长时间最接近本意。
 */
export function clampTtl(ttl: number, allowed: number[]): number {
  return allowed.includes(ttl) ? ttl : allowed[allowed.length - 1];
}
