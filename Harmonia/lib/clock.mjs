export function currentTime(now = Date.now()) {
  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(now);
  return `当前北京时间（Asia/Shanghai，UTC+08:00）：${time}。今天的日期和星期以此为准，历史消息里的“今天/明天”属于当时，不代表现在。`;
}
