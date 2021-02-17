import path from 'path';
import childProcess from 'child_process';
import {promises as fs} from 'fs';
import {fileURLToPath} from 'url';
import isWsl from 'is-wsl';
import isDocker from 'is-docker';
import defineLazyProperty from 'define-lazy-prop';
import AggregateError from 'aggregate-error';

// Node.js ESM doesn't expose __dirname (https://stackoverflow.com/a/50052194/8384910)
const currentDirectoryName = path.dirname(fileURLToPath(import.meta.url));

// Path to included `xdg-open`.
const localXdgOpenPath = path.join(currentDirectoryName, 'xdg-open');

const {platform} = process;

/**
Get the mount point for fixed drives in WSL.

@inner
@returns {string} The mount point.
*/
const getWslDrivesMountPoint = (() => {
	// Default value for "root" param
	// according to https://docs.microsoft.com/en-us/windows/wsl/wsl-config
	const defaultMountPoint = '/mnt/';

	let mountPoint;

	return async function () {
		if (mountPoint) {
			// Return memoized mount point value
			return mountPoint;
		}

		const configFilePath = '/etc/wsl.conf';

		let isConfigFileExists = false;
		try {
			await fs.access(configFilePath, fs.constants.F_OK);
			isConfigFileExists = true;
		} catch {}

		if (!isConfigFileExists) {
			return defaultMountPoint;
		}

		const configContent = await fs.readFile(configFilePath, {encoding: 'utf8'});
		const configMountPoint = /root\s*=\s*(?<mountPoint>.*)/g.exec(configContent)?.groups?.mountPoint?.trim();

		if (!configMountPoint) {
			return defaultMountPoint;
		}

		mountPoint = configMountPoint.endsWith('/') ? configMountPoint : `${configMountPoint}/`;

		return mountPoint;
	};
})();

const pTryEach = async (array, mapper) => {
	const errors = [];

	for await (const item of array) {
		try {
			return await mapper(item);
		} catch (error) {
			errors.push(error);
		}
	}

	throw new AggregateError(errors);
};

const open = async (target, options) => {
	if (typeof target !== 'string') {
		throw new TypeError('Expected a `target`');
	}

	options = {
		wait: false,
		background: false,
		allowNonzeroExitCode: false,
		...options
	};

	if (Array.isArray(options.app)) {
		return pTryEach(options.app, singleApp => open(target, {
			...options,
			app: singleApp
		}));
	}

	let {name: app, appArguments = []} = options.app ?? {};

	if (Array.isArray(app)) {
		return pTryEach(app, appName => open(target, {
			...options,
			app: {
				name: appName,
				arguments: appArguments
			}
		}));
	}

	let command;
	const cliArguments = [];
	const childProcessOptions = {};

	if (platform === 'darwin') {
		command = 'open';

		if (options.wait) {
			cliArguments.push('--wait-apps');
		}

		if (options.background) {
			cliArguments.push('--background');
		}

		if (app) {
			cliArguments.push('-a', app);
		}
	} else if (platform === 'win32' || (isWsl && !isDocker())) {
		const mountPoint = await getWslDrivesMountPoint();

		command = isWsl ?
			`${mountPoint}c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` :
			`${process.env.SYSTEMROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell`;

		cliArguments.push(
			'-NoProfile',
			'-NonInteractive',
			'–ExecutionPolicy',
			'Bypass',
			'-EncodedCommand'
		);

		if (!isWsl) {
			childProcessOptions.windowsVerbatimArguments = true;
		}

		const encodedArguments = ['Start'];

		if (options.wait) {
			encodedArguments.push('-Wait');
		}

		if (app) {
			// Double quote with double quotes to ensure the inner quotes are passed through.
			// Inner quotes are delimited for PowerShell interpretation with backticks.
			encodedArguments.push(`"\`"${app}\`""`, '-ArgumentList');
			appArguments.unshift(target);
		} else {
			encodedArguments.push(`"${target}"`);
		}

		if (appArguments.length > 0) {
			appArguments = appArguments.map(arg => `"\`"${arg}\`""`);
			encodedArguments.push(appArguments.join(','));
		}

		// Using Base64-encoded command, accepted by PowerShell, to allow special characters.
		target = Buffer.from(encodedArguments.join(' '), 'utf16le').toString('base64');
	} else {
		if (app) {
			command = app;
		} else {
			// When bundled by Webpack, there's no actual package file path and no local `xdg-open`.
			const isBundled = !currentDirectoryName || currentDirectoryName === '/';

			// Check if local `xdg-open` exists and is executable.
			let exeLocalXdgOpen = false;
			try {
				await fs.access(localXdgOpenPath, fs.constants.X_OK);
				exeLocalXdgOpen = true;
			} catch {}

			const useSystemXdgOpen = process.versions.electron ||
				platform === 'android' || isBundled || !exeLocalXdgOpen;
			command = useSystemXdgOpen ? 'xdg-open' : localXdgOpenPath;
		}

		if (appArguments.length > 0) {
			cliArguments.push(...appArguments);
		}

		if (!options.wait) {
			// `xdg-open` will block the process unless stdio is ignored
			// and it's detached from the parent even if it's unref'd.
			childProcessOptions.stdio = 'ignore';
			childProcessOptions.detached = true;
		}
	}

	cliArguments.push(target);

	if (platform === 'darwin' && appArguments.length > 0) {
		cliArguments.push('--args', ...appArguments);
	}

	const subprocess = childProcess.spawn(command, cliArguments, childProcessOptions);

	if (options.wait) {
		return new Promise((resolve, reject) => {
			subprocess.once('error', reject);

			subprocess.once('close', exitCode => {
				if (options.allowNonzeroExitCode && exitCode > 0) {
					reject(new Error(`Exited with code ${exitCode}`));
					return;
				}

				resolve(subprocess);
			});
		});
	}

	subprocess.unref();

	return subprocess;
};

function detectPlatformBinary(platformMap, {wsl}) {
	if (wsl && isWsl) {
		return wsl;
	}

	if (!platformMap.has(platform)) {
		throw new Error(`${platform} is not supported`);
	}

	return platformMap.get(platform);
}

const apps = {};

defineLazyProperty(apps, 'chrome', () => detectPlatformBinary(new Map([
	['darwin', 'google chrome canary'],
	['win32', 'Chrome'],
	['linux', ['google-chrome', 'google-chrome-stable']]
]), {
	wsl: '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe'
}));

defineLazyProperty(apps, 'firefox', () => detectPlatformBinary(new Map([
	['darwin', 'firefox'],
	['win32', 'C:\\Program Files\\Mozilla Firefox\\firefox.exe'],
	['linux', 'firefox']
]), {
	wsl: '/mnt/c/Program Files/Mozilla Firefox/firefox.exe'
}));

open.apps = apps;

export default open;
