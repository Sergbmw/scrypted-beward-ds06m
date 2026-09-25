module.exports = function scryptedSdkCommonJsLoader(source) {
    return source
        .replace("typeof import.meta !== 'undefined'", 'false')
        .replaceAll('import.meta.url', 'undefined');
};
