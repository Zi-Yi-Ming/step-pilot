export interface Task {
  id: string;
  category: string;
  difficulty: string;
  description: string;
  repository: string;
  setup?: string;
  verify?: Array<{
    type: 'test' | 'file_contains' | 'file_not_contains' | 'file_exists' | 'command' | 'custom';
    command?: string;
    path?: string;
    pattern?: string;
    expect?: Record<string, unknown>;
  }>;
  success_criteria?: {
    tests_pass?: boolean;
    max_turns?: number;
  };
  timeout: number;
  metadata?: Record<string, unknown>;
}

export interface Profile {
  id: string;
  name: string;
  description: string;
  config: Record<string, unknown>;
}

export interface BenchmarkSummary {
  task_id: string;
  runs: number;
  success_rate: number;
  final_verifier_failure_rate: number;
  timeout_rate: number;
  mean_duration_ms: number;
  median_duration_ms: number;
  mean_turns: number;
  mean_tool_calls: number;
  mean_tool_errors: number;
  mean_retries: number;
  mean_compactions: number;
  mean_total_tokens: number;
  failure_taxonomy: Record<string, number>;
  // Recovery metrics (first_pass_success_rate, recovery_given_failure,
  // avg_turns_to_pass_given_failure) are intentionally omitted because the
  // current runner executes verifier checks only once after the agent run
  // finishes. We cannot observe intermediate verifier states, so any
  // "recovery" metric would be inferred rather than measured.
}

export interface BenchmarkReport {
  benchmark_version: string;
  timestamp: string;
  model: string;
  provider: string;
  step_pilot_commit: string;
  profiles: string[];
  results: RunResult[];
  summaries: Record<string, BenchmarkSummary>;
}

export interface RunResult {
  task_id: string;
  category: string;
  profile: string;
  model: string;
  provider: string;
  step_pilot_commit: string;
  run_index: number;
  success: boolean;
  duration_ms: number;
  turns: number;
  tool_calls: number;
  tool_errors: number;
  retries: number;
  compactions: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  stop_reason: string | null;
  failure_reason: string | null;
  checks_passed: number;
  checks_failed: number;
  /**
   * 评测框架侧故障标记。**这是为「可信度」而存在的字段。**
   *
   * 只记录 verify 命令本身因环境问题无法执行（找不到测试文件、模块解析失败、
   * 命令不存在等），不把模型超时/错误导致的「verify 未执行」混进来。
   * `null` 表示没有识别到框架故障。
   */
  harness_error: string | null;
  /**
   * agent 没有发出终态成功事件，因此 verify 被跳过。
   * 这是模型/运行状态的失败信号，不是 harness_error；单独字段避免把超时伪装成环境坏。
   */
  verification_skipped: boolean;
  events: RawEvent[];
}

export interface RawEvent {
  type: string;
  [key: string]: unknown;
}
