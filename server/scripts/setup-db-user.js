import mysql from 'mysql2/promise';

async function setup() {
  try {
    const conn = await mysql.createConnection({
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: 'root',
    });

    await conn.query('CREATE DATABASE IF NOT EXISTS helpdesk;');
    await conn.query("CREATE USER IF NOT EXISTS 'helpdesk'@'%' IDENTIFIED BY 'Hd_pr0d_2026_Wq8x';");
    await conn.query("CREATE USER IF NOT EXISTS 'helpdesk'@'localhost' IDENTIFIED BY 'Hd_pr0d_2026_Wq8x';");
    await conn.query("ALTER USER 'helpdesk'@'%' IDENTIFIED BY 'Hd_pr0d_2026_Wq8x';");
    await conn.query("ALTER USER 'helpdesk'@'localhost' IDENTIFIED BY 'Hd_pr0d_2026_Wq8x';");
    await conn.query("GRANT ALL PRIVILEGES ON helpdesk.* TO 'helpdesk'@'%';");
    await conn.query("GRANT ALL PRIVILEGES ON helpdesk.* TO 'helpdesk'@'localhost';");
    await conn.query('FLUSH PRIVILEGES;');

    console.log('Database and user configured successfully!');
    await conn.end();
  } catch (err) {
    console.error('Setup failed:', err);
    process.exit(1);
  }
}

setup();
