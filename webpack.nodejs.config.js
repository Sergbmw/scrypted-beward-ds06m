const config = require(process.env.SCRYPTED_DEFAULT_WEBPACK_CONFIG);

// The published @scrypted/sdk is CommonJS, but Webpack can classify its
// generated index as a harmony module when consumed outside the Scrypted
// monorepo. The SDK initializes through the Node `exports` object, so force
// CommonJS parsing to match official in-tree plugin builds.
config.module.rules.unshift({
    test: /@scrypted[\\/]sdk[\\/]dist[\\/]src[\\/]index\.js$/,
    type: 'javascript/dynamic',
    use: require.resolve('./webpack.sdk-commonjs-loader'),
});

module.exports = config;
