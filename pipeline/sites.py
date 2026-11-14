"""Site definitions for the terrain pipeline. Map coordinates are the source
rasters' Equirectangular Mars 2000 sphere metres (R = 3396190 m, lat_ts = 0)."""

MARS_R = 3396190.0
USGS = "https://planetarymaps.usgs.gov/mosaic"

SITES = {
    "jezero": {
        "name": "Jezero Crater - Perseverance landing area",
        "dtm": f"{USGS}/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif",
        "ortho": f"{USGS}/mars2020_trn/HiRISE/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif",
        # crop centre in map metres; covers the landing site, Seitah, the delta front and Belva crater
        "center_map": (4588700.0, 1094000.0),
        "size_m": 5120.0,
        "height_px": 2048,
        "ortho_px": 4096,
        "regional_size_m": 20480.0,
        "regional_px": 1024,
        "credits": [
            "Mars 2020 Terrain Relative Navigation HiRISE DTM mosaic (1 m) and orthomosaic (25 cm): "
            "USGS Astrogeology Science Center / NASA / JPL-Caltech / University of Arizona",
        ],
    },
}
