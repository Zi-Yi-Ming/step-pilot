/**
 * 配置分享模板导出：把 config.toml 里的敏感字段剥离成可分享的模板。
 * 小团队场景：渠道/模型配置由一个人调好后导出模板，队友填自己的 key 即可用。
 *
 * 为什么走行级过滤而不是 parse+stringify：用户的 config.toml 带注释与排版，
 * TOML 序列化会丢光注释；api_key 由 tomlAppend 写入、恒为单行标量，行级过滤
 * 保结构、保注释，只动目标行。手写 api_key 也几乎总是单行，多行字面量的
 * 残余风险由输出末尾的自查提示兜底（不承诺审计，只做剥离）。
 *
 * 剥离对象：任何 section 下的 `api_key = ...` 行（顶层 / [providers.*] / [models.*]）。
 * api_key_env 不剥——它是环境变量名不是密钥本体。
 */

/** 剥离后留下的占位注释行（保持 TOML 有效性：纯注释，不影响解析）。 */
export const API_KEY_PLACEHOLDER = '# api_key =（已剥离：分享模板不含密钥，填入你自己的 key 即可用）';

export interface ExportTemplateResult {
  output: string;
  /** 剥离的 api_key 行数（0 = 模板里已无密钥，调用方可据此提示）。 */
  stripped: number;
}

export function exportConfigTemplate(text: string): ExportTemplateResult {
  let stripped = 0;
  const out = text.split(/\r?\n/).map((line) => {
    if (/^\s*api_key\s*=/.test(line)) {
      stripped += 1;
      return API_KEY_PLACEHOLDER;
    }
    return line;
  });
  return { output: out.join('\n'), stripped };
}
