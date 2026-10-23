// Keep this policy independent of ArkWeb so its traversal/origin cases can run on the host.
export class LocalOrigin {
  static readonly ORIGIN: string = 'https://localhost';
  static readonly START_URL: string = 'https://localhost/';

  static isLoopbackRequest(value: string): boolean {
    const match = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i);
    if (match === null) {
      return false;
    }
    let authority: string = match[1];
    try {
      authority = decodeURIComponent(authority).toLowerCase();
    } catch (_) {
      return true;
    }
    const host: string = authority.substring(authority.lastIndexOf('@') + 1);
    return /^(localhost\.?|127(?:\.[0-9]{1,3}){3}|\[::1\])(?::.*)?$/.test(host);
  }

  static assetPath(value: string): string | undefined {
    const match = value.match(/^https:\/\/localhost(?::443)?(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/i);
    if (match === null) {
      return undefined;
    }
    let path: string;
    try {
      path = decodeURIComponent(match[1] || '/');
    } catch (_) {
      return undefined;
    }
    if (!LocalOrigin.isSafePath(path)) {
      return undefined;
    }
    return path === '/' ? '/index.html' : path;
  }

  static isSafePath(path: string): boolean {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\%\u0000-\u001f\u007f?#]/.test(path)) {
      return false;
    }
    const parts: string[] = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      if (parts[index] === '.' || parts[index] === '..' || (parts[index] === '' && path !== '/')) {
        return false;
      }
    }
    return true;
  }

  static isAppPage(value: string): boolean {
    return LocalOrigin.assetPath(value) === '/index.html';
  }

  static isExternalHttps(value: string): boolean {
    return /^https:\/\/[^\s/@?#]+(?:[/?#][^\s]*)?$/i.test(value) && !LocalOrigin.isLoopbackRequest(value);
  }
}
