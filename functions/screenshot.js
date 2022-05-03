const { builder } = require("@netlify/functions");
const chromium = require("chrome-aws-lambda");

function isFullUrl(url) {
  try {
    new URL(url);
    return true;
  } catch(e) {
    // invalid url OR local path
    return false;
  }
}

async function screenshot(url, { format, viewport, dpr = 1, withJs = true, wait, timeout = 8500 }) {
  // Must be between 3000 and 8500
  timeout = Math.min(Math.max(timeout, 3000), 8500);

  const browser = await chromium.puppeteer.launch({
    executablePath: await chromium.executablePath, // await chromium.executablePath // '/opt/homebrew/bin/chromium'
    args: chromium.args,
    defaultViewport: {
      width: viewport[0],
      height: viewport[1],
      deviceScaleFactor: parseFloat(dpr),
    },
    headless: chromium.headless,
    userDataDir: './.chromium_user_data',
  });

  const page = await browser.newPage();

  if(!withJs) {
    page.setJavaScriptEnabled(false);
  }

  // set user agent
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.41 Safari/537.36 Edg/100.0.1185.39');

  let response;
  if(url.indexOf('instagram.com') > -1) {
    response = await Promise.race([
      handleInstagram(url, page, timeout),
      new Promise(resolve => {
        setTimeout(() => {
          resolve(false); // false is expected below
        }, 8500); // we need time to execute the window.stop before the top level timeout hits
      }),
    ]);
  } else {
    response = await Promise.race([
      page.goto(url, {
        waitUntil: wait || ["load"],
        timeout,
      }),
      new Promise(resolve => {
        setTimeout(() => {
          resolve(false); // false is expected below
        }, timeout  - 1500); // we need time to execute the window.stop before the top level timeout hits
      }),
    ]);
  }

  if(response === false) { // timed out, resolved false
    await page.evaluate(() => window.stop());
  }

  // let statusCode = response.status();
  // TODO handle 4xx/5xx status codes better

  let options = {
    type: format,
    encoding: "base64",
    fullPage: false,
    captureBeyondViewport: false,
    clip: {
      x: 0,
      y: 0,
      width: viewport[0],
      height: viewport[1],
    }
  };

  if(format === "jpeg") {
    options.quality = 80;
  }

  let output = await page.screenshot(options);

  await browser.close();

  return output;
}

// Based on https://github.com/DavidWells/netlify-functions-workshop/blob/master/lessons-code-complete/use-cases/13-returning-dynamic-images/functions/return-image.js
async function handler(event, context) {
  // e.g. /https%3A%2F%2Fwww.11ty.dev%2F/small/1:1/smaller/
  let pathSplit = event.path.split("/").filter(entry => !!entry);
  let [url, size, aspectratio, zoom, cachebuster] = pathSplit;
  let format = "jpeg"; // hardcoded for now, but png and webp are supported!
  let viewport = [];

  // Manage your own frequency by using a _ prefix and then a hash buster string after your URL
  // e.g. /https%3A%2F%2Fwww.11ty.dev%2F/_20210802/ and set this to today’s date when you deploy
  if(size && size.startsWith("_")) {
    cachebuster = size;
    size = undefined;
  }
  if(aspectratio && aspectratio.startsWith("_")) {
    cachebuster = aspectratio;
    aspectratio = undefined;
  }
  if(zoom && zoom.startsWith("_")) {
    cachebuster = zoom;
    zoom = undefined;
  }

  // Options
  let pathOptions = {};
  let optionsMatch = (cachebuster || "").split("_").filter(entry => !!entry);
  for(let o of optionsMatch) {
    let [key, value] = o.split(":");
    pathOptions[key.toLowerCase()] = parseInt(value, 10);
  }

  let wait = ["load"];
  if(pathOptions.wait === 0) {
    wait = ["domcontentloaded"];
  } else if(pathOptions.wait === 1) {
    wait = ["load"];
  } else if(pathOptions.wait === 2) {
    wait = ["load", "networkidle0"];
  } else if(pathOptions.wait === 3) {
    wait = ["load", "networkidle2"];
  }

  let timeout;
  if(pathOptions.timeout) {
    timeout = pathOptions.timeout * 1000;
  }

  // Set Defaults
  format = format || "jpeg";
  aspectratio = aspectratio || "1:1";
  size = size || "small";
  zoom = zoom || "standard";

  let dpr;
  if(zoom === "bigger") {
    dpr = 1.4;
  } else if(zoom === "smaller") {
    dpr = 0.71428571;
  } else if(zoom === "standard") {
    dpr = 1;
  }

  if(size === "small") {
    if(aspectratio === "1:1") {
      viewport = [375, 375];
    } else if(aspectratio === "9:16") {
      viewport = [375, 667];
    }
  } else if(size === "medium") {
    if(aspectratio === "1:1") {
      viewport = [650, 650];
    } else if(aspectratio === "9:16") {
      viewport = [650, 1156];
    }
  } else if(size === "large") {
    // 0.5625 aspect ratio not supported on large
    if(aspectratio === "1:1") {
      viewport = [1024, 1024];
    }
  } else if(size === "opengraph") {
    // ignores aspectratio
    // always maintain a 1200×630 output image
    if(zoom === "bigger") { // dpr = 1.4
      viewport = [857, 450];
    } else if(zoom === "smaller") { // dpr = 0.714
      viewport = [1680, 882];
    } else {
      viewport = [1200, 630];
    }
  }

  url = decodeURIComponent(url);

  try {
    if(!isFullUrl(url)) {
      throw new Error(`Invalid \`url\`: ${url}`);
    }

    if(!viewport || viewport.length !== 2) {
      throw new Error("Incorrect API usage. Expects one of: /:url/ or /:url/:size/ or /:url/:size/:aspectratio/")
    }

    let output = await screenshot(url, {
      format,
      viewport,
      dpr,
      wait,
      timeout,
    });

    // output to Function logs
    console.log(url, format, { viewport }, { size }, { dpr }, { aspectratio });

    return {
      statusCode: 200,
      headers: {
        "content-type": `image/${format}`
      },
      body: output,
      isBase64Encoded: true
    };
  } catch (error) {
    console.log("Error", error);

    return {
      // We need to return 200 here or Firefox won’t display the image
      // HOWEVER a 200 means that if it times out on the first attempt it will stay the default image until the next build.
      statusCode: 200,
      // HOWEVER HOWEVER, we can set a ttl of 3600 which means that the image will be re-requested in an hour.
      ttl: 3600,
      headers: {
        "content-type": "image/svg+xml",
        "x-error-message": error.message
      },
      body: `<svg version="1.1" id="L4" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 100 100" enable-background="new 0 0 0 0" xml:space="preserve"><circle fill="#000" stroke="none" cx="6" cy="50" r="6"><animate attributeName="opacity" dur="1s" values="0;1;0" repeatCount="indefinite" begin="0.1"/></circle><circle fill="#000" stroke="none" cx="26" cy="50" r="6"><animate attributeName="opacity" dur="1s" values="0;1;0" repeatCount="indefinite" begin="0.2"/></circle><circle fill="#000" stroke="none" cx="46" cy="50" r="6"><animate attributeName="opacity" dur="1s" values="0;1;0" repeatCount="indefinite" begin="0.3"/></circle></svg>`,
      isBase64Encoded: false,
    };
  }
}

async function handleInstagram(url, page, timeout) {
  let response = await page.goto(url);

  // check logged in
  if (await page.$('header') !== null) {
    console.log("Instagram - already logged in");
    return response;
  } else {
    console.log("Instagram - handling login");
  }

  // remove cookie notice
  const div_selector_to_remove= "[role=presentation]";
  await page.evaluate((sel) => {
    var element = document.querySelector(sel);
    element.parentNode.removeChild(element);
  }, div_selector_to_remove);

  // do login
  await page.waitForSelector('[type=submit]');
  await page.type('[name=username]', 'elbarbabrb');
  await page.type('[type="password"]', 'cn4Wi3DpKDc6Jv');
  await page.click('[type=submit]');
  await page.waitForNavigation();

  response = await page.goto(url,{waitUntil: 'networkidle0'});

  return response;
}

exports.handler = builder(handler);
