import { env } from '../../config/env';

const brand = () => 'Eplug';

function layout(title: string, body: string, cta?: { url: string; label: string }): string {
  const button = cta
    ? `<p style="margin:28px 0"><a href="${cta.url}" style="background:#00a862;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block">${cta.label}</a></p>
       <p style="color:#64748b;font-size:13px">Товч ажиллахгүй бол энэ холбоосыг хөтөчдөө хуулж тавина уу:<br><span style="word-break:break-all">${cta.url}</span></p>`
    : '';

  return `<!doctype html><html lang="mn"><body style="margin:0;background:#f1f5f9;padding:28px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:32px">
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:0 0 24px">
      <tr>
        <td style="vertical-align:middle;padding-right:10px">
          <img src="${env.APP_URL}/eplug-mark.png" alt="Eplug" width="32" height="32" style="width:32px;height:32px;border-radius:8px;display:block" />
        </td>
        <td style="vertical-align:middle">
          <span style="font-size:18px;font-weight:700;color:#0f172a">${brand()}</span>
        </td>
      </tr>
    </table>
    <h1 style="font-size:20px;margin:0 0 12px">${title}</h1>
    ${body}
    ${button}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0">
    <p style="color:#94a3b8;font-size:12px;margin:0">Хэн нэгэн Eplug дээр энэ хаягийг ашигласан тул та энэ и-мэйлийг хүлээн авлаа. Хэрэв та биш бол ямар нэг зүйл хийх шаардлагагүй.</p>
  </div></body></html>`;
}

export function verifyEmail(url: string) {
  return {
    subject: `Eplug и-мэйл хаягаа баталгаажуулах`,
    text: `${brand()}-д тавтай морил. Энэ холбоосыг нээж и-мэйл хаягаа баталгаажуулна уу:\n\n${url}`,
    html: layout(
      'И-мэйл хаягаа баталгаажуулах',
      `<p style="line-height:1.6;margin:0">Eplug бүртгэл үүсгэсэнд баярлалаа. Цэнэглэлтийн баримт, бүртгэлийн мэдэгдэл илгээх боломжтой болгохын тулд хаягаа баталгаажуулна уу.</p>`,
      { url, label: 'И-мэйл баталгаажуулах' },
    ),
  };
}

export function signupSms(code: string, minutes: number): string {
  return `Burtguulekh code ${code}. ${minutes} minutyn daraa khuchingui bolno.`;
}

export function pinResetSms(code: string, minutes: number): string {
  return `PIN sergeekh code ${code}. ${minutes} minutyn daraa khuchingui bolno. Busadtai buu khuvaaltsaarai.`;
}

export function phoneVerifySms(code: string, minutes: number): string {
  return `Batalgaajuulakh code ${code}. ${minutes} minutyn daraa khuchingui bolno.`;
}

export function walletTopUpSms(topUpAmount: string | number, uldegdel?: string): string {
  if (uldegdel) {
    return `tany hetewch ${topUpAmount} amjilttai tseneglegdlee, uldegdel ${uldegdel}`;
  }
  return `tany hetewch ${topUpAmount} amjilttai tseneglegdlee`;
}

export function sessionStopSms(
  kwh: string | number,
  usedAmount: string | number,
  uldegdel: string,
): string {
  return `${kwh}kwt ashiglaj ${usedAmount} tolbor tologdloo, uldegdel ${uldegdel}`;
}

export function refundSms(
  amount: string | number,
  accountNumber: string | undefined,
  uldegdel: string | number,
): string {
  if (accountNumber) {
    return `Eplug butsaaltiin ${amount} dun ${accountNumber} toot dansand shiljuullee. uldegdel ${uldegdel}`;
  }
  return `Eplug butsaaltiin ${amount} dun dansand shiljuullee. uldegdel ${uldegdel}`;
}