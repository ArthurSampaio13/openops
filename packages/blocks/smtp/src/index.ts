import { BlockAuth, Property, createBlock } from '@openops/blocks-framework';
import { BlockCategory } from '@openops/shared';
import { sendEmail } from './lib/actions/send-email';
import { smtpCommon } from './lib/common';

const SMTPPorts = [25, 465, 587, 2525];

export const smtpAuth = BlockAuth.CustomAuth({
  authProviderKey: 'SMTP',
  authProviderDisplayName: 'SMTP',
  authProviderLogoUrl: `https://static.openops.com/blocks/smtp.png`,
  required: true,
  props: {
    host: Property.ShortText({
      displayName: 'Host',
      required: true,
    }),
    email: Property.ShortText({
      displayName: 'Email',
      required: true,
    }),
    password: Property.SecretText({
      displayName: 'Password',
      required: true,
    }),
    port: Property.StaticDropdown({
      displayName: 'Port',
      required: true,
      options: {
        disabled: false,
        options: SMTPPorts.map((port) => {
          return {
            label: port.toString(),
            value: port,
          };
        }),
      },
    }),
    TLS: Property.Checkbox({
      displayName: 'Require TLS?',
      defaultValue: false,
      required: true,
    }),
  },
  validate: async ({ auth }) => {
    try {
      const transporter = smtpCommon.createSMTPTransport(auth);
      return new Promise((resolve, reject) => {
        transporter.verify(function (error, success) {
          if (error) {
            resolve({ valid: false, error: JSON.stringify(error) });
          } else {
            resolve({ valid: true });
          }
        });
      });
    } catch (e) {
      const castedError = e as Record<string, unknown>;
      const code = castedError?.['code'];
      switch (code) {
        case 'EDNS':
          return {
            valid: false,
            error: 'SMTP server not found or unreachable with error code: EDNS',
          };
        case 'CONN':
          return {
            valid: false,
            error: 'SMTP server connection failed with error code: CONN',
          };
        default:
          break;
      }
      return {
        valid: false,
        error: JSON.stringify(e),
      };
    }
  },
});

export const smtp = createBlock({
  displayName: 'SMTP',
  description: 'Send emails using Simple Mail Transfer Protocol',
  minimumSupportedRelease: '0.5.0',
  logoUrl: 'https://static.openops.com/blocks/smtp.png',
  categories: [BlockCategory.COLLABORATION],
  authors: [
    'tahboubali',
    'abaza738',
    'kishanprmr',
    'MoShizzle',
    'khaledmashaly',
    'abuaboud',
    'pfernandez98',
  ],
  auth: smtpAuth,
  actions: [sendEmail],
  triggers: [],
});
