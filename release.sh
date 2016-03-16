#!/bin/sh

cwd=$(pwd)
dst="$cwd/cocos-debug"
out="$dst/out"
zipfile="$cwd/cocos-debug.zip"

# compile typescript
npm run prepublish

if [ -d "$dst" ]; then
	rm -rf "$dst"
fi

if [ -f "$zipfile" ]; then
	rm -f "$zipfile"
fi

mkdir "$dst"
mkdir "$out"

# copy files
package_path="$cwd/package.json"
cocosFXDebug="$cwd/out/cocosFXDebug.js"
cocosFXProtocol="$cwd/out/cocosFirefoxProtocol.js"

cp "$package_path" "$dst"
cp "$cocosFXDebug" "$out"
cp "$cocosFXProtocol" "$out"

# npm install
cd ./cocos-debug
npm install --production

# zip
cd ..
zip -r cocos-debug.zip ./cocos-debug
