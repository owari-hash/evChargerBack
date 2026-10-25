import 'dotenv/config';
process.env.JWT_SECRET ||= 'test-secret-at-least-32-characters-long!';

async function main() {
  const { sendSms, templates } = await import('../src/driver/notify');
  const phone = process.argv[2] || '88111653';
  const kwh = process.argv[3] || '12.50';
  const usedAmount = process.argv[4] || '18,750';
  const uldegdel = process.argv[5] || '31,250';

  console.log(`\n========================================`);
  console.log(`Testing SMS for phone: ${phone}`);
  console.log(`========================================\n`);

  // 1. Test Usage / Stop SMS
  const stopText = templates.sessionStopSms(kwh, usedAmount, uldegdel);
  console.log(`[1] Testing Session Stop SMS:`);
  console.log(`    Content: "${stopText}"`);
  const stopResult = await sendSms({ to: phone, text: stopText });
  console.log(`    Result:`, stopResult);

  // 2. Test Wallet TopUp SMS
  const topUpText = templates.walletTopUpSms(usedAmount, uldegdel);
  console.log(`\n[2] Testing Wallet TopUp SMS:`);
  console.log(`    Content: "${topUpText}"`);
  const topUpResult = await sendSms({ to: phone, text: topUpText });
  console.log(`    Result:`, topUpResult);

  // 3. Test Refund SMS
  const refundText = templates.refundSms('8,650', '5025753481', '4100');
  console.log(`\n[3] Testing Refund SMS:`);
  console.log(`    Content: "${refundText}"`);
  const refundResult = await sendSms({ to: phone, text: refundText });
  console.log(`    Result:`, refundResult);

  console.log(`\nDone!\n`);
}

main().catch((err) => {
  console.error('Error testing SMS:', err);
  process.exit(1);
});
