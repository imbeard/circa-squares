const fs = require('fs');
const { builder } = require("@netlify/functions");
const chromium = require("chrome-aws-lambda");

const instagramCookiesFilePath = '/tmp/instagram_cookies.json';

function isFullUrl(url) {
  try {
    new URL(url);
    return true;
  } catch(e) {
    // invalid url OR local path test
    return false;
  }
}

async function screenshot(url, { format, viewport, dpr = 1, withJs = true, wait, timeout = 23000, colorscheme }) {
  // Must be between 3000 and 23000
  timeout = Math.min(Math.max(timeout, 3000), 23000);

  const path = process.env.NETLIFY_DEV ? '/opt/homebrew/bin/chromium' : await chromium.executablePath;

  const browser = await chromium.puppeteer.launch({
    executablePath: path,
    //args: chromium.args,
    defaultViewport: {
      width: viewport[0],
      height: viewport[1],
      deviceScaleFactor: parseFloat(dpr),
    },
    userDataDir: '/tmp/user-data-dir',
    headless: true,
    args: ['--no-sandbox'],
  });

  const page = await browser.newPage();

  await page._client.send('Network.setCacheDisabled', {
    cacheDisabled: false
  });

  if(!withJs) {
    page.setJavaScriptEnabled(false);
  }

  // set color scheme
  if(colorscheme && (colorscheme == 'light' || colorscheme == 'dark')) {
    await page.emulateMediaFeatures([{
      name: 'prefers-color-scheme', value: colorscheme
    }]);
  }

  // set user agent
  // chrome on android for mobile, chrome on windows for desktop
  if(viewport[0] < 1024) {
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.41 Mobile Safari/537.36');
  } else {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.54 Safari/537.36');
  }

  let response;
  if(url.indexOf('instagram.com') > -1) {
    response = await Promise.race([
      handleInstagram(url, page, wait),
      new Promise(resolve => {
        setTimeout(() => {
          resolve(false); // false is expected below
        }, timeout  - 1500); // we need time to execute the window.stop before the top level timeout hits
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
    // await page.evaluate(() => window.stop()); // stop loading page to take screenshot anyway of what is on the page so far
    await browser.close(); // OR close the browser
    throw new Error(`Timed out`); // throw error and do not return an image so it have to be requested again
  }

  // handle circa website (local, staging and live)
  if(url.indexOf('circa.local') > -1 || url.indexOf('wordpress-347619-2422041.cloudwaysapps.com') > -1 || url.indexOf('circa.art') > -1) {
    handleCirca(page);
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
  let [url, size, aspectratio, colorscheme, zoom, cachebuster] = pathSplit;
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
  if(colorscheme && colorscheme.startsWith("_")) {
    cachebuster = colorscheme;
    colorscheme = undefined;
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

    /*const urlObj = new URL(url);
    if(urlObj) {
      const puppy = parseInt(urlObj.searchParams.get("puppy")) - 2;
      urlObj.searchParams.set("puppy", puppy);
      url = urlObj.toString();
    }*/

    let output = await screenshot(url, {
      format,
      viewport,
      dpr,
      wait,
      timeout,
      colorscheme,
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
    console.log(url, format, { viewport }, { size }, { dpr }, { aspectratio });
    console.log(error);

    return {
      // We need to return 200 here or Firefox won’t display the image
      // HOWEVER a 200 means that if it times out on the first attempt it will stay the default image until the next build.
      // statusCode: 200,
      statusCode: 500,
      // HOWEVER HOWEVER, we can set a ttl of 3600 which means that the image will be re-requested in an hour.
      // ttl: 3600,
      ttl: 60,
      headers: {
        // "content-type": `image/${format}`,
        "x-error-message": error.message
      },
      body: ``,
      isBase64Encoded: false,
    };
  }
}

async function handleInstagram(url, page, wait) {
  // Restore Session Cookies
  const previousSession = fs.existsSync(instagramCookiesFilePath)
  if (previousSession) {
    // If file exist load the cookies
    const cookiesString = fs.readFileSync(instagramCookiesFilePath);
    const parsedCookies = JSON.parse(cookiesString);
    if (parsedCookies.length !== 0) {
      for (let cookie of parsedCookies) {
        await page.setCookie(cookie)
      }
      console.log('Session has been loaded in the browser')
    }
  }

  let response = await page.goto(url, {
    waitUntil: wait || ["load"]
  });

  // remove cookie notice
  const div_selector_to_remove= "body > [role=presentation]";
  await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if(element && element.parentNode) {
      element.parentNode.removeChild(element);
    }
  }, div_selector_to_remove);

  // check logged in
  if (await page.$('article') !== null) {
    console.log("Instagram - already logged in");
    return response;
  } else {
    console.log("Instagram - handling login");
  }

  // do login
  await page.waitForSelector('[type=submit]');
  await page.type('[name=username]', 'circa.art.service');
  await page.type('[type="password"]', 'HJVp99wXsnREQrm');
  await page.click('[type=submit]');

  // check login success or failure
  response = await Promise.race([
    page.waitForNavigation(),
    new Promise(resolve => {
      page.waitForSelector('#slfErrorAlert').catch((e) => {});
      resolve(false);
    }),
  ]);

  if(response === false) {
    throw new Error(`Instagram - login failed`);
  }

  response = await page.goto(url, {
    waitUntil: wait || ["load"]
  });

  // Save Session Cookies
  const cookiesObject = await page.cookies()
  // Write cookies to temp file to be used in other profile pages
  fs.writeFile(
    instagramCookiesFilePath,
    JSON.stringify(cookiesObject),
    function(err) { 
      if (err) {
        console.log('The file could not be written.', err)
      } else {
        console.log('Session has been successfully saved')
      }
    }
  );

  return response;
}

async function handleCirca(page) {
  // remove header and footer
  const div_selector_to_remove= "header, footer";
  await page.evaluate((sel) => {
    const elements = document.querySelectorAll(sel);
    for(let i=0; i< elements.length; i++){
      if(elements[i] && elements[i].parentNode) {
        elements[i].parentNode.removeChild(elements[i]);
      }
    }
  }, div_selector_to_remove);

  // remove main tag padding top
  let mainElem = await page.$('main');
  await mainElem.evaluate((el) => el.style.paddingTop = 0);
}

exports.handler = builder(handler);
