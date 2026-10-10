var webpack = require('webpack');
var path = require('path');

module.exports = {
	entry: [
		'./src/js/main.js',
	],
	output: {
		path: path.resolve(__dirname, 'dist'),
		filename: 'bundle.js',
		publicPath: '/dist/'
	},
	resolve: {
		extensions: ['.js', '.css'],
		alias: {
			Utilities: path.resolve(__dirname, './../node_modules/')
		}
	},
	module: {
		rules: [
			{
				test: /\.css$/,
				use: [
					'style-loader',
					{
						loader: 'css-loader',
						options: {url: false}
					}
				]
			},
			{
				test: /\.js$/,
				exclude: /(node_modules|bower_components)/,
				use: ['babel-loader']
			},
		]
	},
	plugins: [
		new webpack.ProvidePlugin({
            $: "jquery",
            jQuery: "jquery",
            "window.jQuery": "jquery"
		}),
		new webpack.DefinePlugin({
			VERSION: JSON.stringify(require("./package.json").version)
		}),
	],
	devtool: "cheap-module-source-map",
	devServer: {
		// host: '0.0.0.0',
		//contentBase: "./",
		static: {
			directory: path.resolve(__dirname, "./"),
		},
		// miniPaint AI: forward /api to the local Runware proxy (server/index.js), same origin, no CORS.
		proxy: [
			{
				context: ['/api'],
				target: 'http://127.0.0.1:' + (process.env.AI_PROXY_PORT || 8787),
			},
		],
		// miniPaint AI: the static root is the repo root, so block files that must never be served.
		setupMiddlewares: (middlewares, devServer) => {
			const blocked = /^\/(\.git|\.env|server|node_modules|docs)(\/|$)|^\/(plan\.md|package(-lock)?\.json)$|^\/\./i;
			middlewares.unshift({
				name: 'block-private-paths',
				middleware: (req, res, next) => {
					let pathname = req.url.split('?')[0];
					try {
						pathname = decodeURIComponent(pathname);
					} catch (e) {}
					pathname = path.posix.normalize(pathname);
					if (blocked.test(pathname)) {
						res.statusCode = 404;
						res.end('Not found');
						return;
					}
					next();
				},
			});
			return middlewares;
		},
	}
};