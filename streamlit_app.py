"""Run with: python -m streamlit run streamlit_app.py."""
import streamlit as st
import streamlit.components.v1 as components

from calculator.streamlit_bundle import write_component


st.set_page_config(
    page_title="Прогноз офтальмологической нагрузки",
    page_icon="🏥",
    layout="wide",
    initial_sidebar_state="collapsed",
)
st.markdown(
    """<style>
    .block-container {max-width: none; padding: 0.5rem 0.5rem 1rem;}
    [data-testid="stAppViewContainer"] {background: #f5f7f6;}
    </style>""",
    unsafe_allow_html=True,
)
component_directory = write_component()
calculator = components.declare_component("ophthalmology", path=str(component_directory))
calculator(key="ophthalmology-calculator", default=None)
