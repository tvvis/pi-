/**
 * User-facing hint strings shown when a response ends abnormally but without a
 * hard error.
 */

/**
 * Shown when a response ends with stopReason "length" (provider reported
 * max_tokens / incomplete). This typically happens when extended thinking
 * consumes the whole output token budget, silently truncating the response.
 */
export const TRUNCATED_RESPONSE_HINT =
	"Response truncated: reached the output token limit (max_tokens). If thinking was cut off, lower the thinking level or reduce the thinking budget (thinkingBudgets).";
