/**
 * Platform-aware message formatting.
 *
 * Different messaging platforms have different Markdown dialects.
 * This module ensures outbound text is safe for the target platform.
 */

/**
 * Characters that must be escaped for Telegram MarkdownV2.
 * See https://core.telegram.org/bots/api#markdownv2-style
 */
const TELEGRAM_ESCAPE_RE = /([_*\[\]()~`>#\+\-=|{}.!\\])/g;

/**
 * Escape a string for Telegram MarkdownV2 formatting.
 */
export function escapeTelegramMarkdown(text: string): string {
  return text.replace(TELEGRAM_ESCAPE_RE, "\\$1");
}

/**
 * Format text for the given platform.
 *
 * - `telegram` — escapes MarkdownV2 special characters.
 * - All other platforms — returns text unchanged.
 */
export function formatForPlatform(text: string, platform: string): string {
  if (platform === "telegram") {
    return escapeTelegramMarkdown(text);
  }
  return text;
}
