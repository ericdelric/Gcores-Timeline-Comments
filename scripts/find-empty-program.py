import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HEADERS = {
    "Accept": "application/vnd.api+json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/156 Safari/537.36",
}


def get(url):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


listing = get("https://www.gcores.com/gapi/v1/radios?page%5Blimit%5D=30&sort=-published-at")
ids = [item["id"] for item in listing["data"]]
print("ids", ids[:10], "count", len(ids))


def inspect(radio_id):
    radio = get(f"https://www.gcores.com/gapi/v1/radios/{radio_id}?include=media%2Cmedia.timelines")
    included = radio.get("included", [])
    timelines = sum(1 for item in included if item.get("type") == "timelines")
    comments = get(
        f"https://www.gcores.com/gapi/v1/radios/{radio_id}/comments?page%5Blimit%5D=100&page%5Boffset%5D=0&sort=-radio-timestamp&include=user"
    )
    stamped = sum(
        1
        for item in comments.get("data", [])
        if item.get("attributes", {}).get("radio-timestamp") is not None
    )
    return radio_id, radio["data"]["attributes"].get("title", "")[:24], timelines, stamped


with ThreadPoolExecutor(max_workers=5) as pool:
    for result in pool.map(inspect, ids):
        print(result)
