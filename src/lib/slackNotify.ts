const SLACK_BOT_TOKEN = import.meta.env.VITE_SLACK_BOT_TOKEN as string;
const SLACK_CHANNEL_ID = import.meta.env.VITE_SLACK_CHANNEL_ID as string;

interface SlackNotifyParams {
  action: '발송확인' | '입고확인' | '마킹작업' | '출고확인';
  user: string;
  date: string;
  items: { name: string; qty: number }[];
  extra?: string;
}

const ACTION_EMOJI: Record<string, string> = {
  '발송확인': '📦',
  '입고확인': '📥',
  '마킹작업': '🏷️',
  '출고확인': '🚚',
};

export async function notifySlack(params: SlackNotifyParams): Promise<void> {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) return;

  const { action, user, date, items, extra } = params;
  const emoji = ACTION_EMOJI[action] || '📋';
  const totalQty = items.reduce((s, i) => s + i.qty, 0);

  const itemLines = items.slice(0, 10).map((i) => `• ${i.name}: ${i.qty}개`);
  if (items.length > 10) {
    itemLines.push(`_...외 ${items.length - 10}종_`);
  }

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *${action} 완료*\n담당자: ${user} | 날짜: ${date}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${items.length}종 / ${totalQty.toLocaleString()}개*\n${itemLines.join('\n')}`,
      },
    },
  ];

  if (extra) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: extra },
    });
  }

  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: SLACK_CHANNEL_ID,
        text: `${emoji} ${action} 완료 — ${user} (${items.length}종 ${totalQty}개)`,
        blocks,
      }),
    });
  } catch {
    // 슬랙 알림 실패는 무시 (핵심 기능 아님)
    console.warn('Slack 알림 전송 실패');
  }
}
