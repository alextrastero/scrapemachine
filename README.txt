scraper and email

Cron job that will run on github actions to send an email of certain conditions have **** on a website.

Setup

1. Set the email credentials as environment variables or GitHub secrets:
   - EMAIL_USER
   - EMAIL_PASSWORD

2. Customize the website URL and email settings in index.js

Usage

- Run with npm:
```
npm start
```

- Test with dry-run mode (no emails will be sent):
```
npm run dry-run
```

GitHub Actions

The included GitHub workflow will automatically run daily at 9:00 AM UTC.
