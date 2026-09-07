"""Web tools: weather and fetching a page.

Open-Meteo is used for weather because it needs no API key. Live web *search*
is handled by Claude's server-side `web_search` tool, wired up in agent.py.
"""

from __future__ import annotations

import html
import re
from typing import Any

from . import ToolError, tool

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore[assignment]

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
USER_AGENT = "Thursday/0.1 (personal assistant)"

# https://open-meteo.com/en/docs - WMO weather interpretation codes
WEATHER_CODES = {
    0: "clear sky",
    1: "mainly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "fog",
    48: "depositing rime fog",
    51: "light drizzle",
    53: "moderate drizzle",
    55: "dense drizzle",
    61: "slight rain",
    63: "moderate rain",
    65: "heavy rain",
    66: "freezing rain",
    67: "heavy freezing rain",
    71: "slight snow",
    73: "moderate snow",
    75: "heavy snow",
    77: "snow grains",
    80: "slight rain showers",
    81: "moderate rain showers",
    82: "violent rain showers",
    85: "slight snow showers",
    86: "heavy snow showers",
    95: "thunderstorm",
    96: "thunderstorm with slight hail",
    99: "thunderstorm with heavy hail",
}


def _client():
    if httpx is None:
        raise ToolError("httpx is not installed; run: pip install httpx")
    return httpx.Client(timeout=20.0, follow_redirects=True, headers={"User-Agent": USER_AGENT})


@tool
def get_weather(location: str, days: int = 3, units: str = "metric") -> dict[str, Any]:
    """Get the current weather and a short forecast for a place.

    Args:
        location: A city or place name, e.g. "Bangkok" or "Chiang Mai".
        days: How many days of forecast to include (1-7).
        units: "metric" for Celsius/km-h or "imperial" for Fahrenheit/mph.
    """
    imperial = units.lower().startswith("i")
    with _client() as client:
        geo = client.get(GEOCODE_URL, params={"name": location, "count": 1, "language": "en"})
        geo.raise_for_status()
        results = geo.json().get("results") or []
        if not results:
            raise ToolError(f"could not find a place called {location!r}")
        place = results[0]

        params: dict[str, Any] = {
            "latitude": place["latitude"],
            "longitude": place["longitude"],
            "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
            "forecast_days": max(1, min(days, 7)),
            "timezone": "auto",
        }
        if imperial:
            params.update(temperature_unit="fahrenheit", wind_speed_unit="mph")

        forecast = client.get(FORECAST_URL, params=params)
        forecast.raise_for_status()
        data = forecast.json()

    current = data.get("current", {})
    daily = data.get("daily", {})
    degree = "°F" if imperial else "°C"
    return {
        "place": ", ".join(
            str(p) for p in (place.get("name"), place.get("admin1"), place.get("country")) if p
        ),
        "current": {
            "temperature": f"{current.get('temperature_2m')}{degree}",
            "feels_like": f"{current.get('apparent_temperature')}{degree}",
            "humidity_percent": current.get("relative_humidity_2m"),
            "wind": f"{current.get('wind_speed_10m')} {'mph' if imperial else 'km/h'}",
            "conditions": WEATHER_CODES.get(current.get("weather_code"), "unknown"),
        },
        "forecast": [
            {
                "date": date,
                "high": f"{daily['temperature_2m_max'][i]}{degree}",
                "low": f"{daily['temperature_2m_min'][i]}{degree}",
                "rain_chance_percent": daily["precipitation_probability_max"][i],
                "conditions": WEATHER_CODES.get(daily["weather_code"][i], "unknown"),
            }
            for i, date in enumerate(daily.get("time", []))
        ],
    }


_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)


def html_to_text(raw: str) -> str:
    """Strip tags and scripts out of an HTML document."""
    without_scripts = _SCRIPT_RE.sub(" ", raw)
    text = _TAG_RE.sub(" ", without_scripts)
    return re.sub(r"\n\s*\n+", "\n\n", re.sub(r"[ \t]+", " ", html.unescape(text))).strip()


@tool
def fetch_url(url: str, max_chars: int = 8000) -> dict[str, Any]:
    """Fetch a web page or API endpoint and return its text.

    Args:
        url: The full URL, including https://.
        max_chars: Truncate the extracted text after this many characters.
    """
    if not url.lower().startswith(("http://", "https://")):
        raise ToolError("url must start with http:// or https://")
    try:
        with _client() as client:
            response = client.get(url)
            response.raise_for_status()
    except Exception as exc:  # httpx raises a family of transport/status errors
        raise ToolError(f"could not fetch {url}: {exc}") from exc

    content_type = response.headers.get("content-type", "")
    body = response.text
    text = html_to_text(body) if "html" in content_type else body
    truncated = len(text) > max_chars
    return {
        "url": str(response.url),
        "status": response.status_code,
        "content_type": content_type.split(";")[0],
        "text": text[:max_chars] + ("\n...(truncated)" if truncated else ""),
    }
