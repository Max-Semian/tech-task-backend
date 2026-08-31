// Первым делом: тестовая БД. Каждый тестовый файл запускается node --test
// в отдельном процессе -> уникальная БД по pid, файлы не мешают друг другу.
const explicit = process.env.TEST_DATABASE_URL;
if (explicit) {
  process.env.DATABASE_URL = explicit;
} else {
  const base = 'postgres://app:app@localhost:5432';
  process.env.DATABASE_URL = `${base}/shop_test_${process.pid}`;
}
process.env.LOG_LEVEL = 'silent';
